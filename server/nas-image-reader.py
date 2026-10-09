"""常驻只读 FD worker。只解析指定文件，不扫描目录或输出路径。"""
import errno
import json
import os
import stat
import sys
from collections import OrderedDict

HEADER_LIMIT = 8192
DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK


class Rejected(Exception):
    def __init__(self, code):
        self.code = code


def identity(s):
    return s.st_dev, s.st_ino


class Reader:
    def __init__(self, root, max_bytes, cache_size):
        self.root = root
        self.max_bytes = max_bytes
        self.cache_size = cache_size
        self.root_fd = None
        self.root_identity = None
        self.directories = OrderedDict()

    def clear(self):
        for fd, _initial_identity in reversed(list(self.directories.values())):
            try:
                os.close(fd)
            except OSError:
                pass
        self.directories.clear()
        if self.root_fd is not None:
            try:
                os.close(self.root_fd)
            except OSError:
                pass
        self.root_fd = self.root_identity = None

    def check_root(self):
        try:
            named = os.stat(self.root, follow_symlinks=False)
        except OSError as error:
            if error.errno not in (errno.ENOENT, errno.ENOTDIR, errno.ELOOP):
                raise
            raise Rejected('ROOT_IDENTITY_CHANGED')
        if not stat.S_ISDIR(named.st_mode) or identity(named) != self.root_identity:
            raise Rejected('ROOT_IDENTITY_CHANGED')

    def check_edge(self, parent, name, directory, initial_identity):
        try:
            named = os.stat(name, dir_fd=parent, follow_symlinks=False)
        except OSError as error:
            if error.errno not in (errno.ENOENT, errno.ENOTDIR, errno.ELOOP):
                raise
            raise Rejected('DIRECTORY_IDENTITY_CHANGED')
        # 串行worker持有未关闭FD时dev/ino不变；仅named edge必须重新访问NAS。
        if not stat.S_ISDIR(named.st_mode) or identity(named) != initial_identity:
            raise Rejected('DIRECTORY_IDENTITY_CHANGED')

    def trim(self):
        # 当前请求已结束，才淘汰FD；祖先失效同时关闭所有后代，避免孤儿句柄。
        while len(self.directories) > self.cache_size:
            oldest = next(iter(self.directories))
            descendants = [k for k in self.directories if k[:len(oldest)] == oldest]
            for key in sorted(descendants, key=len, reverse=True):
                os.close(self.directories.pop(key)[0])

    def read(self, file):
        parts = file.split('/') if isinstance(file, str) else []
        if not parts or len(parts) > 32 or len(file) > 4096 or any(not p or p in ('.', '..') or '\\' in p or any(ord(c) < 32 or ord(c) == 127 for c in p) for p in parts):
            raise Rejected('INVALID_FILE')
        fd = None
        try:
            if self.root_fd is None:
                self.root_fd = os.open(self.root, DIRECTORY_FLAGS)
                self.root_identity = identity(os.fstat(self.root_fd))
            self.check_root()
            parent = self.root_fd
            edges = []
            for i, name in enumerate(parts[:-1]):
                key = tuple(parts[:i + 1])
                entry = self.directories.get(key)
                if entry is None:
                    directory = os.open(name, DIRECTORY_FLAGS, dir_fd=parent)
                    try:
                        entry = directory, identity(os.fstat(directory))
                    except BaseException:
                        os.close(directory)
                        raise
                    self.directories[key] = entry
                else:
                    self.directories.move_to_end(key)
                self.check_edge(parent, name, *entry)
                edges.append((parent, name, *entry))
                parent = entry[0]
            fd = os.open(parts[-1], FILE_FLAGS, dir_fd=parent)
            before = os.fstat(fd)
            if not stat.S_ISREG(before.st_mode) or before.st_size < 12 or before.st_size > self.max_bytes:
                raise Rejected('INVALID_FILE')
            chunks = []
            remaining = before.st_size
            while remaining:
                chunk = os.read(fd, min(256 * 1024, remaining))
                if not chunk:
                    raise Rejected('SHORT_READ')
                chunks.append(chunk)
                remaining -= len(chunk)
            after = os.fstat(fd)
            try:
                named = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
            except OSError as error:
                if error.errno not in (errno.ENOENT, errno.ENOTDIR, errno.ELOOP):
                    raise
                raise Rejected('FILE_IDENTITY_CHANGED')
            signature = lambda s: (s.st_dev, s.st_ino, s.st_size)
            if not stat.S_ISREG(named.st_mode) or signature(before) != signature(after) or signature(after) != signature(named):
                raise Rejected('FILE_IDENTITY_CHANGED')
            self.check_root()
            for ancestor, name, directory, initial_identity in edges:
                self.check_edge(ancestor, name, directory, initial_identity)
            return b''.join(chunks)
        except BaseException:
            # namespace/错误后不得永久复用旧root或孤立目录，下一请求重新安全打开。
            if fd is not None:
                os.close(fd)
                fd = None
            self.clear()
            raise
        finally:
            if fd is not None:
                os.close(fd)
            self.trim()


def main():
    root, max_bytes, cache_size = sys.argv[1:]
    max_bytes, cache_size = int(max_bytes), int(cache_size)
    if not os.path.isabs(root) or os.path.normpath(root) != root or not 12 <= max_bytes <= 64 * 1024 * 1024 or not 8 <= cache_size <= 64:
        return
    reader = Reader(root, max_bytes, cache_size)
    try:
        while True:
            line = sys.stdin.buffer.readline(HEADER_LIMIT + 2)
            if not line:
                break
            if len(line) > HEADER_LIMIT + 1 or not line.endswith(b'\n'):
                break
            try:
                request = json.loads(line)
                if not isinstance(request, dict) or set(request) != {'id', 'file'} or type(request['id']) is not int or not 1 <= request['id'] <= 9007199254740991:
                    break
            except (ValueError, TypeError):
                break
            try:
                body = reader.read(request['file'])
                header = {'id': request['id'], 'ok': True, 'length': len(body)}
            except BaseException as error:
                code = getattr(error, 'code', None) or errno.errorcode.get(getattr(error, 'errno', None), 'WORKER_FAILED')
                body = b''
                header = {'id': request['id'], 'ok': False, 'code': code}
            sys.stdout.buffer.write(json.dumps(header, separators=(',', ':')).encode('ascii') + b'\n')
            if body:
                sys.stdout.buffer.write(body)
            sys.stdout.buffer.flush()
    finally:
        reader.clear()


if __name__ == '__main__':
    main()
