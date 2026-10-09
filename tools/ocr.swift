// 图片文字识别（契约 §16.1 / §17）：用系统自带 Vision（VNRecognizeTextRequest）。
// 由服务端首次使用时 swiftc 编译到 DATA_DIR/bin/ocr。支持 png / jpg / webp / heic（ImageIO 能读的都行）。
// 用法：ocr <图片文件>  → 标准输出 UTF-8 识别文字（按从上到下、从左到右排好，一行一段）。
// 退出码：0 成功；2 参数错；3 读不了图片；5 识别失败；6 像素太大（超过 5000 万像素，先读尺寸、不解码）。
import Foundation
import Vision
import ImageIO

let args = CommandLine.arguments
guard args.count == 2 else {
  FileHandle.standardError.write("usage: ocr <image>\n".data(using: .utf8)!)
  exit(2)
}
let url = URL(fileURLWithPath: args[1]) as CFURL
guard let src = CGImageSourceCreateWithURL(url, nil) else { exit(3) }
// 先只读尺寸：压缩后很小、解码后几 GB 的超大像素图直接拒绝，不交给 Vision。
let maxPixels = 50_000_000
if let p = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any] {
  let pw = (p[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue ?? 0
  let ph = (p[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue ?? 0
  if pw <= 0 || ph <= 0 { exit(3) }
  if pw > 100_000 || ph > 100_000 || pw * ph > maxPixels { exit(6) }
} else { exit(3) }
guard let img = CGImageSourceCreateImageAtIndex(src, 0, [kCGImageSourceShouldCache: false] as CFDictionary) else { exit(3) }
if img.width * img.height > maxPixels { exit(6) }
// 拍照的 JPEG / HEIC 可能带旋转方向。
var orientation = CGImagePropertyOrientation.up
if let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
   let o = props[kCGImagePropertyOrientation] as? UInt32, let v = CGImagePropertyOrientation(rawValue: o) {
  orientation = v
}
// 透明背景（截图、导出的 PNG）上的黑字会被当成黑底黑字：先铺白底；太小的图放大到至少 1600 宽，识别更准。
func flatten(_ src: CGImage) -> CGImage {
  let scale: CGFloat = src.width < 1600 ? min(4, 1600 / CGFloat(max(src.width, 1))) : 1
  let w = Int(CGFloat(src.width) * scale), h = Int(CGFloat(src.height) * scale)
  guard w > 0, h > 0, w * h <= 80_000_000,
        let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return src }
  ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
  ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
  ctx.interpolationQuality = .high
  ctx.draw(src, in: CGRect(x: 0, y: 0, width: w, height: h))
  return ctx.makeImage() ?? src
}
let flat = flatten(img)
let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
req.usesLanguageCorrection = true
let wanted = ["zh-Hans", "zh-Hant", "en-US", "ja-JP"]
if let supported = try? req.supportedRecognitionLanguages() {
  let langs = wanted.filter { supported.contains($0) }
  req.recognitionLanguages = langs.isEmpty ? ["en-US"] : langs
} else {
  req.recognitionLanguages = ["zh-Hans", "en-US"]
}
let handler = VNImageRequestHandler(cgImage: flat, orientation: orientation, options: [:])
do { try handler.perform([req]) } catch { exit(5) }
let obs = (req.results ?? []).compactMap { o -> (CGRect, String)? in
  guard let t = o.topCandidates(1).first?.string, !t.isEmpty else { return nil }
  return (o.boundingBox, t)
}
// Vision 坐标原点在左下：先按行（minY 从大到小，容差半行高），行内按 x。
let sorted = obs.sorted { a, b in
  let tol = min(a.0.height, b.0.height) * 0.5
  if abs(a.0.midY - b.0.midY) > tol { return a.0.midY > b.0.midY }
  return a.0.minX < b.0.minX
}
var lines: [String] = []
var lastY: CGFloat? = nil
var cur = ""
for (box, t) in sorted {
  if let y = lastY, abs(y - box.midY) <= box.height * 0.5 {
    cur += " " + t
  } else {
    if !cur.isEmpty { lines.append(cur) }
    cur = t
    lastY = box.midY
  }
}
if !cur.isEmpty { lines.append(cur) }
FileHandle.standardOutput.write((lines.joined(separator: "\n") + "\n").data(using: .utf8)!)
exit(0)
