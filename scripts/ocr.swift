import AppKit
import Foundation
import PDFKit
import Vision

let arguments = CommandLine.arguments
guard arguments.count >= 2 else {
  FileHandle.standardError.write(Data("Usage: ocr.swift <pdf-path>\n".utf8))
  exit(2)
}

let pdfURL = URL(fileURLWithPath: arguments[1])
guard let document = PDFDocument(url: pdfURL) else {
  FileHandle.standardError.write(Data("Unable to open PDF: \(pdfURL.path)\n".utf8))
  exit(1)
}

func renderPage(_ page: PDFPage) -> CGImage? {
  let mediaBox = page.bounds(for: .mediaBox)
  if mediaBox.isEmpty {
    return nil
  }

  let maxDimension: CGFloat = 2200
  let scale = min(maxDimension / max(mediaBox.width, mediaBox.height), 2.5)
  let width = max(Int(mediaBox.width * scale), 1)
  let height = max(Int(mediaBox.height * scale), 1)

  guard
    let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
    let context = CGContext(
      data: nil,
      width: width,
      height: height,
      bitsPerComponent: 8,
      bytesPerRow: 0,
      space: colorSpace,
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    )
  else {
    return nil
  }

  context.setFillColor(NSColor.white.cgColor)
  context.fill(CGRect(x: 0, y: 0, width: width, height: height))
  context.scaleBy(x: scale, y: scale)
  context.translateBy(x: 0, y: mediaBox.height)
  context.scaleBy(x: 1, y: -1)
  page.draw(with: .mediaBox, to: context)
  return context.makeImage()
}

func recognizeText(in image: CGImage) throws -> String {
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = true
  request.recognitionLanguages = ["it-IT", "en-US"]

  let handler = VNImageRequestHandler(cgImage: image, options: [:])
  try handler.perform([request])

  let observations = request.results ?? []
  return observations
    .compactMap { $0.topCandidates(1).first?.string.trimmingCharacters(in: .whitespacesAndNewlines) }
    .filter { !$0.isEmpty }
    .joined(separator: "\n")
}

var pages: [String] = []
for pageIndex in 0..<document.pageCount {
  guard let page = document.page(at: pageIndex), let image = renderPage(page) else {
    continue
  }

  let text = try recognizeText(in: image)
  if !text.isEmpty {
    pages.append(text)
  }
}

print(pages.joined(separator: "\n\n"))
