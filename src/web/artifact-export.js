const encoder = new TextEncoder();

function xml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function safeFilename(value) {
  return String(value || "便读知识整理")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 72) || "便读知识整理";
}

let crcTable;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) ? (0xEDB88320 ^ (value >>> 1)) : (value >>> 1);
      }
      crcTable[index] = value >>> 0;
    }
  }
  let crc = 0xFFFFFFFF;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function writeU16(view, offset, value) {
  view.setUint16(offset, value, true);
}

function writeU32(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
}

function concatBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function zipStore(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const now = new Date();
  const dosTime = ((now.getHours() & 0x1F) << 11) | ((now.getMinutes() & 0x3F) << 5) |
    Math.floor(now.getSeconds() / 2);
  const dosDate = (((now.getFullYear() - 1980) & 0x7F) << 9) | (((now.getMonth() + 1) & 0x0F) << 5) |
    (now.getDate() & 0x1F);
  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = typeof file.data === "string" ? encoder.encode(file.data) : file.data;
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length + data.length);
    const localView = new DataView(local.buffer);
    writeU32(localView, 0, 0x04034B50);
    writeU16(localView, 4, 20);
    writeU16(localView, 6, 0x0800);
    writeU16(localView, 8, 0);
    writeU16(localView, 10, dosTime);
    writeU16(localView, 12, dosDate);
    writeU32(localView, 14, crc);
    writeU32(localView, 18, data.length);
    writeU32(localView, 22, data.length);
    writeU16(localView, 26, name.length);
    writeU16(localView, 28, 0);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    localParts.push(local);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    writeU32(centralView, 0, 0x02014B50);
    writeU16(centralView, 4, 20);
    writeU16(centralView, 6, 20);
    writeU16(centralView, 8, 0x0800);
    writeU16(centralView, 10, 0);
    writeU16(centralView, 12, dosTime);
    writeU16(centralView, 14, dosDate);
    writeU32(centralView, 16, crc);
    writeU32(centralView, 20, data.length);
    writeU32(centralView, 24, data.length);
    writeU16(centralView, 28, name.length);
    writeU16(centralView, 30, 0);
    writeU16(centralView, 32, 0);
    writeU16(centralView, 34, 0);
    writeU16(centralView, 36, 0);
    writeU32(centralView, 38, 0);
    writeU32(centralView, 42, offset);
    central.set(name, 46);
    centralParts.push(central);
    offset += local.length;
  }
  const centralOffset = offset;
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  writeU32(endView, 0, 0x06054B50);
  writeU16(endView, 8, files.length);
  writeU16(endView, 10, files.length);
  writeU32(endView, 12, centralSize);
  writeU32(endView, 16, centralOffset);
  return new Blob([...localParts, ...centralParts, end], { type: "application/zip" });
}

function documentParts(artifact) {
  const body = [];
  body.push(`<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>${xml(artifact.title)}</w:t></w:r></w:p>`);
  if (artifact.subtitle) {
    body.push(`<w:p><w:pPr><w:pStyle w:val="Subtitle"/></w:pPr><w:r><w:t>${xml(artifact.subtitle)}</w:t></w:r></w:p>`);
  }
  if (artifact.summary) {
    body.push(`<w:p><w:r><w:t>${xml(artifact.summary)}</w:t></w:r></w:p>`);
  }
  for (const section of artifact.sections || []) {
    body.push(`<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${xml(section.heading)}</w:t></w:r></w:p>`);
    for (const paragraph of section.paragraphs || []) {
      const lines = String(paragraph).split("\n");
      body.push(`<w:p>${lines.map((line, index) => `<w:r>${index ? "<w:br/>" : ""}<w:t xml:space="preserve">${xml(line)}</w:t></w:r>`).join("")}</w:p>`);
    }
  }
  if (artifact.citations?.length) {
    body.push(`<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>引用依据</w:t></w:r></w:p>`);
    artifact.citations.forEach((citation, index) => {
      body.push(`<w:p><w:r><w:t>${index + 1}. ${xml(citation.sourceTitle)}${citation.page ? ` · 第 ${citation.page} 页` : ""}：${xml(citation.quote)}</w:t></w:r></w:p>`);
    });
  }
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos" w:eastAsia="Noto Sans CJK SC"/><w:sz w:val="23"/><w:szCs w:val="23"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="360" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/><w:rPr><w:rFonts w:eastAsia="Noto Serif CJK SC"/><w:b/><w:sz w:val="38"/></w:rPr><w:pPr><w:spacing w:after="240"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:qFormat/><w:rPr><w:color w:val="5F6A65"/><w:sz w:val="24"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:qFormat/><w:rPr><w:rFonts w:eastAsia="Noto Serif CJK SC"/><w:b/><w:color w:val="2F5E52"/><w:sz w:val="30"/></w:rPr><w:pPr><w:keepNext/><w:spacing w:before="280" w:after="120"/></w:pPr></w:style>
</w:styles>`;
  return [
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    },
    { name: "word/document.xml", data: document },
    { name: "word/styles.xml", data: styles },
    {
      name: "word/_rels/document.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    },
  ];
}

function paragraph(text, options = {}) {
  const size = Number(options.size) || 2200;
  const bold = options.bold ? ' b="1"' : "";
  const color = options.color || "1B2421";
  const align = options.align ? `<a:pPr algn="${options.align}"/>` : "";
  return `<a:p>${align}<a:r><a:rPr lang="zh-CN" sz="${size}"${bold}><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="Aptos"/><a:ea typeface="Noto Sans CJK SC"/></a:rPr><a:t>${xml(text)}</a:t></a:r></a:p>`;
}

let shapeId = 2;
function textShape({ x, y, width, height, paragraphs, fill = "", line = "" }) {
  const id = shapeId++;
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Text ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${width}" cy="${height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${fill ? `<a:solidFill><a:srgbClr val="${fill}"/></a:solidFill>` : "<a:noFill/>"}${line ? `<a:ln w="12700"><a:solidFill><a:srgbClr val="${line}"/></a:solidFill></a:ln>` : "<a:ln><a:noFill/></a:ln>"}</p:spPr><p:txBody><a:bodyPr wrap="square" lIns="160000" tIns="120000" rIns="160000" bIns="120000"/><a:lstStyle/>${paragraphs.length ? paragraphs.join("") : "<a:p/>"}</p:txBody></p:sp>`;
}

function groupShape() {
  return `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>`;
}

function slidePart(slide, index, total, artifact) {
  const parts = [];
  if (index === 0) {
    parts.push(textShape({
      x: 610000, y: 1110000, width: 10970000, height: 750000,
      paragraphs: [paragraph(artifact.title, { size: 3800, bold: true, color: "1B2421" })],
    }));
    if (artifact.subtitle) {
      parts.push(textShape({
        x: 610000, y: 1990000, width: 10400000, height: 650000,
        paragraphs: [paragraph(artifact.subtitle, { size: 2300, color: "5F6A65" })],
      }));
    }
    if (artifact.summary) {
      parts.push(textShape({
        x: 610000, y: 2960000, width: 10000000, height: 1700000,
        paragraphs: [paragraph(artifact.summary, { size: 1900, color: "3F4C47" })],
      }));
    }
    parts.push(textShape({
      x: 610000, y: 5530000, width: 2100000, height: 90000, fill: "2F5E52",
      paragraphs: [],
    }));
  } else {
    parts.push(textShape({
      x: 560000, y: 430000, width: 800000, height: 80000, fill: "2F5E52",
      paragraphs: [],
    }));
    parts.push(textShape({
      x: 560000, y: 760000, width: 10800000, height: 850000,
      paragraphs: [paragraph(slide.title, { size: 2900, bold: true })],
    }));
    parts.push(textShape({
      x: 560000, y: 1720000, width: 10800000, height: 3900000,
      paragraphs: slide.points.map((point) => paragraph(`• ${point}`, { size: 2000, color: "3F4C47" })),
    }));
    parts.push(textShape({
      x: 9800000, y: 6070000, width: 1700000, height: 350000,
      paragraphs: [paragraph(`${index + 1} / ${total}`, { size: 1100, color: "7A847F", align: "r" })],
    }));
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>${groupShape()}${parts.join("")}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

function presentationParts(artifact) {
  shapeId = 2;
  const slides = artifact.slides || [];
  const allSlides = slides.map((slide, index) => slidePart(slide, index, slides.length, artifact));
  const presentationRels = [`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>`];
  const slideIds = [];
  allSlides.forEach((_, index) => {
    const relId = `rId${index + 2}`;
    presentationRels.push(`<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`);
    slideIds.push(`<p:sldId id="${256 + index}" r:id="${relId}"/>`);
  });
  const presentation = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slideIds.join("")}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;
  const slideMaster = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld name="Blank"><p:spTree>${groupShape()}</p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`;
  const slideLayout = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${groupShape()}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
  const theme = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Biandu"><a:themeElements><a:clrScheme name="Biandu"><a:dk1><a:srgbClr val="1B2421"/></a:dk1><a:lt1><a:srgbClr val="FFFEFA"/></a:lt1><a:dk2><a:srgbClr val="2F5E52"/></a:dk2><a:lt2><a:srgbClr val="F3F1EB"/></a:lt2><a:accent1><a:srgbClr val="2F5E52"/></a:accent1><a:accent2><a:srgbClr val="A64B3C"/></a:accent2><a:accent3><a:srgbClr val="B68B3A"/></a:accent3><a:accent4><a:srgbClr val="64706B"/></a:accent4><a:accent5><a:srgbClr val="DCE9E2"/></a:accent5><a:accent6><a:srgbClr val="8A7F6D"/></a:accent6><a:hlink><a:srgbClr val="2F5E52"/></a:hlink><a:folHlink><a:srgbClr val="64706B"/></a:folHlink></a:clrScheme><a:fontScheme name="Biandu"><a:majorFont><a:latin typeface="Aptos Display"/><a:ea typeface="Noto Serif CJK SC"/><a:cs typeface="Aptos Display"/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/><a:ea typeface="Noto Sans CJK SC"/><a:cs typeface="Aptos"/></a:minorFont></a:fontScheme><a:fmtScheme name="Biandu"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${allSlides.map((_, index) => `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("")}</Types>`;
  const files = [
    { name: "[Content_Types].xml", data: contentTypes },
    { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>` },
    { name: "ppt/presentation.xml", data: presentation },
    { name: "ppt/_rels/presentation.xml.rels", data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${presentationRels.join("")}</Relationships>` },
    { name: "ppt/slideMasters/slideMaster1.xml", data: slideMaster },
    { name: "ppt/slideMasters/_rels/slideMaster1.xml.rels", data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>` },
    { name: "ppt/slideLayouts/slideLayout1.xml", data: slideLayout },
    { name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels", data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>` },
    { name: "ppt/theme/theme1.xml", data: theme },
  ];
  allSlides.forEach((slide, index) => {
    files.push({ name: `ppt/slides/slide${index + 1}.xml`, data: slide });
    files.push({ name: `ppt/slides/_rels/slide${index + 1}.xml.rels`, data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>` });
  });
  return files;
}

function base64Bytes(value) {
  const binary = atob(String(value || "").split(",").at(-1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function pdfFromJpegPages(images, width, height, pageWidth = 595, pageHeight = 842) {
  const objects = [
    null,
    "<< /Type /Catalog /Pages 2 0 R >>",
    null,
  ];
  const pageIds = [];
  images.forEach((image, index) => {
    const pageId = objects.length;
    const contentId = pageId + 1;
    const imageId = pageId + 2;
    pageIds.push(pageId);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    const content = encoder.encode(`q\n${pageWidth} 0 0 ${pageHeight} 0 0 cm\n/Im0 Do\nQ\n`);
    objects.push({ dict: `<< /Length ${content.length} >>`, stream: content });
    objects.push({
      dict: `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.length} >>`,
      stream: image,
    });
  });
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  const chunks = [encoder.encode("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n")];
  const offsets = [0];
  let length = chunks[0].length;
  for (let index = 1; index < objects.length; index += 1) {
    offsets[index] = length;
    const object = objects[index];
    const head = encoder.encode(`${index} 0 obj\n`);
    let body;
    let tail;
    if (typeof object === "string") {
      body = encoder.encode(object);
      tail = encoder.encode("\nendobj\n");
    } else {
      body = object.stream;
      tail = encoder.encode("\nendstream\nendobj\n");
      const dict = encoder.encode(`${object.dict}\nstream\n`);
      chunks.push(head, dict, body, tail);
      length += head.length + dict.length + body.length + tail.length;
      continue;
    }
    chunks.push(head, body, tail);
    length += head.length + body.length + tail.length;
  }
  const xrefOffset = length;
  let xref = `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let index = 1; index < objects.length; index += 1) {
    xref += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  chunks.push(encoder.encode(xref));
  return new Blob(chunks.map((chunk) => chunk.buffer ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength) : chunk), { type: "application/pdf" });
}

export function createPdfFromJpegPages(images, width, height, options = {}) {
  return pdfFromJpegPages(
    images,
    width,
    height,
    Number(options.pageWidth) || 595,
    Number(options.pageHeight) || 842,
  );
}

function wrapCanvasText(context, text, maxWidth) {
  const output = [];
  for (const rawLine of String(text || "").split("\n")) {
    if (!rawLine.trim()) {
      output.push("");
      continue;
    }
    const tokens = rawLine.includes(" ") ? rawLine.split(/(\s+)/) : Array.from(rawLine);
    let line = "";
    for (const token of tokens) {
      const candidate = `${line}${token}`;
      if (context.measureText(candidate).width <= maxWidth || !line) {
        line = candidate;
      } else {
        output.push(line.trimEnd());
        line = token.trimStart();
      }
    }
    if (line) output.push(line.trimEnd());
  }
  return output;
}

async function createPdfBlob(artifact) {
  const width = 1240;
  const height = 1754;
  const margin = 112;
  const maxWidth = width - margin * 2;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  let y = 0;
  const pages = [];
  const startPage = (isFirst = false) => {
    context.fillStyle = "#fffefa";
    context.fillRect(0, 0, width, height);
    context.textBaseline = "top";
    y = margin;
    if (!isFirst) {
      context.strokeStyle = "rgba(27,36,33,.14)";
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(margin, 76);
      context.lineTo(width - margin, 76);
      context.stroke();
      context.fillStyle = "#5f6a65";
      context.font = '24px "Noto Sans CJK SC","Microsoft YaHei",sans-serif';
      context.fillText("便读 · 私人知识交付", margin, 38);
    }
  };
  const finishPage = () => {
    const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
    pages.push(base64Bytes(dataUrl));
    context.fillStyle = "#fffefa";
    context.fillRect(0, 0, width, height);
  };
  const ensureSpace = (needed) => {
    if (y + needed <= height - margin) return;
    finishPage();
    startPage(false);
  };
  startPage(true);
  context.fillStyle = "#1b2421";
  context.font = 'bold 58px "Noto Serif CJK SC","Songti SC",serif';
  const titleLines = wrapCanvasText(context, artifact.title, maxWidth);
  titleLines.forEach((line) => { ensureSpace(76); context.fillText(line, margin, y); y += 76; });
  if (artifact.subtitle) {
    context.fillStyle = "#5f6a65";
    context.font = '28px "Noto Sans CJK SC","Microsoft YaHei",sans-serif';
    for (const line of wrapCanvasText(context, artifact.subtitle, maxWidth)) {
      ensureSpace(42); context.fillText(line, margin, y); y += 42;
    }
  }
  y += 22;
  if (artifact.summary) {
    context.fillStyle = "#e5efeb";
    const summaryLines = wrapCanvasText(context, artifact.summary, maxWidth - 44);
    const boxHeight = summaryLines.length * 38 + 42;
    ensureSpace(boxHeight + 24);
    context.fillRect(margin, y, maxWidth, boxHeight);
    context.fillStyle = "#2f4f47";
    context.font = '27px "Noto Serif CJK SC","Songti SC",serif';
    y += 22;
    for (const line of summaryLines) { context.fillText(line, margin + 22, y); y += 38; }
    y += 34;
  }
  for (const section of artifact.sections || []) {
    ensureSpace(98);
    y += 24;
    context.fillStyle = "#2f5e52";
    context.font = 'bold 35px "Noto Serif CJK SC","Songti SC",serif';
    for (const line of wrapCanvasText(context, section.heading, maxWidth)) {
      ensureSpace(48); context.fillText(line, margin, y); y += 48;
    }
    y += 10;
    context.fillStyle = "#27312d";
    context.font = '27px "Noto Serif CJK SC","Songti SC",serif';
    for (const paragraphText of section.paragraphs || []) {
      for (const line of wrapCanvasText(context, paragraphText, maxWidth)) {
        ensureSpace(42);
        if (line) context.fillText(line, margin, y);
        y += 42;
      }
      y += 18;
    }
  }
  if (artifact.citations?.length) {
    ensureSpace(100);
    y += 22;
    context.fillStyle = "#2f5e52";
    context.font = 'bold 32px "Noto Serif CJK SC","Songti SC",serif';
    context.fillText("引用依据", margin, y);
    y += 54;
    context.fillStyle = "#5f6a65";
    context.font = '22px "Noto Sans CJK SC","Microsoft YaHei",sans-serif';
    artifact.citations.forEach((citation, index) => {
      const text = `${index + 1}. ${citation.sourceTitle}${citation.page ? ` · 第 ${citation.page} 页` : ""}`;
      for (const line of wrapCanvasText(context, text, maxWidth)) {
        ensureSpace(34); context.fillText(line, margin, y); y += 34;
      }
    });
  }
  finishPage();
  for (let index = 0; index < pages.length; index += 1) {
    // Page numbers are rasterized into a second canvas pass so the total is known.
    const pageCanvas = document.createElement("canvas");
    pageCanvas.width = width;
    pageCanvas.height = height;
    const pageContext = pageCanvas.getContext("2d", { alpha: false });
    const image = new Image();
    const url = URL.createObjectURL(new Blob([pages[index]], { type: "image/jpeg" }));
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
      image.src = url;
    });
    pageContext.drawImage(image, 0, 0, width, height);
    URL.revokeObjectURL(url);
    pageContext.fillStyle = "#7a847f";
    pageContext.font = '21px "Noto Sans CJK SC","Microsoft YaHei",sans-serif';
    pageContext.textAlign = "right";
    pageContext.fillText(`${index + 1} / ${pages.length}`, width - margin, height - 58);
    pages[index] = base64Bytes(pageCanvas.toDataURL("image/jpeg", 0.9));
  }
  return pdfFromJpegPages(pages, width, height);
}

export async function createKnowledgeArtifact(artifact) {
  const filenameBase = safeFilename(artifact.title);
  if (artifact.task === "docx") {
    return {
      filename: `${filenameBase}.docx`,
      blob: createDocxBlob(artifact),
    };
  }
  if (artifact.task === "pptx") {
    return {
      filename: `${filenameBase}.pptx`,
      blob: createPptxBlob(artifact),
    };
  }
  return {
    filename: `${filenameBase}.pdf`,
    blob: await createPdfBlob(artifact),
  };
}

export function createDocxBlob(artifact) {
  return zipStore(documentParts(artifact));
}

export function createPptxBlob(artifact) {
  return zipStore(presentationParts(artifact));
}

function blobMime(filename, blob) {
  if (blob?.type && blob.type !== "application/zip") return blob.type;
  if (/\.docx$/i.test(filename)) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (/\.pptx$/i.test(filename)) return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  if (/\.pdf$/i.test(filename)) return "application/pdf";
  return blob?.type || "application/octet-stream";
}

async function blobBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

export async function downloadArtifactFile({ filename, blob }) {
  const native = globalThis.Capacitor?.Plugins?.BianduBackup;
  if (native?.saveBinary) {
    await native.saveBinary({
      filename,
      mimeType: blobMime(filename, blob),
      content: await blobBase64(blob),
    });
    return { native: true, filename };
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 15_000);
  return { native: false, filename };
}
