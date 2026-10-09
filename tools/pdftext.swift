// PDF 抽文字（契约 §16.1 / §17）：用系统自带 PDFKit。由服务端首次使用时 swiftc 编译到 DATA_DIR/bin/pdftext。
// 用法：pdftext <文件.pdf>  → 标准输出 UTF-8 正文（页与页之间空一行）。
// 退出码：0 成功；2 参数错；3 打不开（不是 PDF / 已损坏）；4 有密码。
import Foundation
import PDFKit

let args = CommandLine.arguments
guard args.count == 2 else {
  FileHandle.standardError.write("usage: pdftext <file.pdf>\n".data(using: .utf8)!)
  exit(2)
}
guard let doc = PDFDocument(url: URL(fileURLWithPath: args[1])) else { exit(3) }
if doc.isLocked { exit(4) }
let out = FileHandle.standardOutput
let maxPages = 5000
for i in 0..<min(doc.pageCount, maxPages) {
  autoreleasepool {
    if let page = doc.page(at: i), let s = page.string {
      out.write(s.data(using: .utf8)!)
    }
    out.write("\n\n\u{000C}".data(using: .utf8)!)
  }
}
exit(0)
