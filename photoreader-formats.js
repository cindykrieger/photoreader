/* Photo-Reader format conversion (Pro). All work stays in the browser. */
(function (root) {
  "use strict";

  var PAGE_SIZE_PRESETS = {
    letter: { id: "letter", label: "Letter", wPt: 612, hPt: 792 },
    a4: { id: "a4", label: "A4", wPt: 595.275590551181, hPt: 841.889763779528 }
  };
  var DEFAULT_PAGE_SIZE = "letter";
  var RENDER_DPI = 144;
  var JPEG_QUALITY = 0.82;

  var EXT_KIND = {
    pdf: "pdf",
    docx: "docx", doc: "doc",
    txt: "text", text: "text", log: "text",
    csv: "csv", tsv: "csv",
    md: "markdown", markdown: "markdown",
    rtf: "rtf",
    html: "html", htm: "html", xhtml: "html",
    xml: "xml",
    png: "image", jpg: "image", jpeg: "image", gif: "image",
    webp: "image", bmp: "image", svg: "image",
    djvu: "djvu", djv: "djvu",
    odt: "odt", ods: "ods", odp: "odp", odg: "odg",
    epub: "epub"
  };

  function configuredPageSizeName() {
    var attr = "";
    try {
      attr = (document.documentElement.getAttribute("data-photoreader-page-size") || "").toLowerCase();
    } catch (e) {}
    if (attr && PAGE_SIZE_PRESETS[attr]) return attr;
    var g = (root.PHOTOREADER_PAGE_SIZE || "").toString().toLowerCase();
    if (g && PAGE_SIZE_PRESETS[g]) return g;
    return DEFAULT_PAGE_SIZE;
  }
  function pageSizeSpec(name, landscape) {
    var n = (name || configuredPageSizeName() || DEFAULT_PAGE_SIZE).toString().toLowerCase();
    var s = PAGE_SIZE_PRESETS[n] || PAGE_SIZE_PRESETS.letter;
    if (landscape) {
      return { id: s.id, label: s.label, wPt: s.hPt, hPt: s.wPt, landscape: true };
    }
    return { id: s.id, label: s.label, wPt: s.wPt, hPt: s.hPt, landscape: false };
  }
  function pagePixels(name, landscape) {
    var s = pageSizeSpec(name, landscape);
    return {
      w: Math.max(1, Math.round(s.wPt * RENDER_DPI / 72)),
      h: Math.max(1, Math.round(s.hPt * RENDER_DPI / 72)),
      wPt: s.wPt,
      hPt: s.hPt,
      id: s.id,
      landscape: !!s.landscape
    };
  }

  function extOf(name) {
    var base = String(name || "").toLowerCase().replace(/\\/g, "/").split("/").pop() || "";
    var d = base.lastIndexOf(".");
    return d >= 0 ? base.slice(d + 1) : "";
  }
  function kindOfName(name) { return EXT_KIND[extOf(name)] || ""; }
  function isSupportedName(name) { return !!kindOfName(name); }
  function isPdfName(name) { return kindOfName(name) === "pdf"; }

  var ACCEPT = [
    "application/pdf,.pdf",
    ".docx,.doc,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/msword",
    ".txt,.csv,.tsv,.md,.markdown,.rtf,.html,.htm,.xml,text/plain,text/csv,text/html,text/xml",
    ".png,.jpg,.jpeg,.gif,.webp,.bmp,.svg,image/png,image/jpeg,image/gif,image/webp,image/bmp,image/svg+xml",
    ".djvu,.djv,image/vnd.djvu,image/x-djvu",
    ".odt,.ods,.odp,.odg,application/vnd.oasis.opendocument.text,application/vnd.oasis.opendocument.spreadsheet,application/vnd.oasis.opendocument.presentation,application/vnd.oasis.opendocument.graphics",
    ".epub,application/epub+zip"
  ].join(",");

  function yieldTick() {
    return new Promise(function (resolve) { setTimeout(resolve, 0); });
  }

  function isPdfBytes(u8) {
    return !!(u8 && u8.length >= 5 && u8[0] === 0x25 && u8[1] === 0x50 && u8[2] === 0x44 && u8[3] === 0x46 && u8[4] === 0x2D);
  }
  function isZipBytes(u8) {
    return !!(u8 && u8.length >= 4 && u8[0] === 0x50 && u8[1] === 0x4B && (u8[2] === 0x03 || u8[2] === 0x05 || u8[2] === 0x07) && (u8[3] === 0x04 || u8[3] === 0x06 || u8[3] === 0x08));
  }
  function isOleBytes(u8) {
    return !!(u8 && u8.length >= 8 && u8[0] === 0xD0 && u8[1] === 0xCF && u8[2] === 0x11 && u8[3] === 0xE0);
  }
  function isRtfBytes(u8) {
    if (!u8 || u8.length < 5) return false;
    return u8[0] === 0x7B && u8[1] === 0x5C && u8[2] === 0x72 && u8[3] === 0x74 && u8[4] === 0x66;
  }
  function isDjvuBytes(u8) {
    // AT&TFORM....DJVM/DJVU/DJVI
    if (!u8 || u8.length < 12) return false;
    var h = String.fromCharCode.apply(null, Array.prototype.slice.call(u8.subarray(0, 4)));
    if (h !== "AT&T") return false;
    var typ = String.fromCharCode.apply(null, Array.prototype.slice.call(u8.subarray(8, 12)));
    return typ === "DJVM" || typ === "DJVU" || typ === "DJVI" || typ === "THUM";
  }

  var INCOMPLETE_FILE_MSG = "This file seems incomplete or damaged, so it can't be opened. Try saving or downloading it again.";
  var MAX_TEXT_CHARS = 750000;
  var MAX_TEXT_PAGES = 400;
  var ZIP_FAIL_RE = /end of central directory|corrupted zip|invalid zip|is this a zip file|bad zip|zip file/i;

  function asArrayBuffer(buf) {
    if (buf instanceof ArrayBuffer) return buf;
    if (buf && buf.buffer instanceof ArrayBuffer && typeof buf.byteLength === "number") {
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    }
    return new Uint8Array(buf).buffer;
  }

  function headAscii(u8, n) {
    if (!u8 || !u8.length) return "";
    var i = 0, end = Math.min(u8.length, n || 1024), s = "", c;
    if (end >= 3 && u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF) i = 3;
    for (; i < end; i++) {
      c = u8[i];
      if (c === 0) continue;
      s += String.fromCharCode(c);
    }
    return s;
  }

  function ltrimSnippet(s) {
    return String(s || "").replace(/^\uFEFF/, "").replace(/^[\s\u0000]+/, "");
  }

  function findSigFromEnd(u8, sig, windowSize) {
    if (!u8 || u8.length < sig.length) return -1;
    var start = Math.max(0, u8.length - (windowSize || (65535 + 128)));
    var i, j, ok;
    for (i = u8.length - sig.length; i >= start; i--) {
      ok = true;
      for (j = 0; j < sig.length; j++) {
        if (u8[i + j] !== sig[j]) { ok = false; break; }
      }
      if (ok) return i;
    }
    return -1;
  }

  function zipHasEndRecord(u8) {
    if (findSigFromEnd(u8, [0x50, 0x4B, 0x05, 0x06], 65535 + 22 + 256) >= 0) return true;
    if (findSigFromEnd(u8, [0x50, 0x4B, 0x06, 0x06], 65535 + 98 + 256) >= 0) return true;
    if (findSigFromEnd(u8, [0x50, 0x4B, 0x06, 0x07], 65535 + 98 + 256) >= 0) return true;
    return false;
  }

  function isHtmlBytes(u8) {
    var s = ltrimSnippet(headAscii(u8, 2048));
    if (/^<!DOCTYPE\s+html/i.test(s) || /^<html[\s>]/i.test(s)) return true;
    if (/^<!--/.test(s) && /<html[\s>]/i.test(headAscii(u8, 8192))) return true;
    return false;
  }

  function isWord2003XmlBytes(u8) {
    var s = headAscii(u8, 4096);
    return /schemas\.microsoft\.com\/office\/word\/2003\/wordml/i.test(s) ||
      /<w:wordDocument\b/i.test(s) || /<wordDocument\b/i.test(s);
  }

  function isXmlBytes(u8) {
    var s = ltrimSnippet(headAscii(u8, 1024));
    return s.charAt(0) === "<" && (/^<\?xml/i.test(s) || /^<[A-Za-z_!?]/.test(s));
  }

  function isImageBytes(u8) {
    if (!u8 || u8.length < 4) return false;
    if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4E && u8[3] === 0x47) return true;
    if (u8[0] === 0xFF && u8[1] === 0xD8 && u8[2] === 0xFF) return true;
    if (u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46) return true;
    if (u8[0] === 0x42 && u8[1] === 0x4D) return true;
    if (u8.length >= 12 && u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46 &&
        u8[8] === 0x57 && u8[9] === 0x45 && u8[10] === 0x42 && u8[11] === 0x50) return true;
    if (/<svg[\s>]/i.test(headAscii(u8, 256))) return true;
    return false;
  }

  function asciiWindow(u8, start, end) {
    start = Math.max(0, start || 0);
    end = Math.min(u8.length, end == null ? u8.length : end);
    var s = "", i, c;
    for (i = start; i < end; i++) {
      c = u8[i];
      s += (c >= 32 && c < 127) ? String.fromCharCode(c) : " ";
    }
    return s;
  }

  function sniffZipKind(u8, nameKind) {
    var s = asciiWindow(u8, 0, 262144) + "\n" + asciiWindow(u8, u8.length - 131072, u8.length);
    if (s.indexOf("word/document.xml") >= 0) return "docx";
    if (s.indexOf("application/epub+zip") >= 0) return "epub";
    if (s.indexOf("application/vnd.oasis.opendocument.spreadsheet") >= 0) return "ods";
    if (s.indexOf("application/vnd.oasis.opendocument.presentation") >= 0) return "odp";
    if (s.indexOf("application/vnd.oasis.opendocument.graphics") >= 0) return "odg";
    if (s.indexOf("application/vnd.oasis.opendocument.text") >= 0) return "odt";
    if (s.indexOf("content.xml") >= 0 && s.indexOf("META-INF") >= 0) return nameKind && /^od[tspg]$/.test(nameKind) ? nameKind : "odt";
    if (s.indexOf("[Content_Types].xml") >= 0) return "docx";
    if (nameKind === "docx" || nameKind === "odt" || nameKind === "ods" || nameKind === "odp" || nameKind === "odg" || nameKind === "epub") return nameKind;
    return "docx";
  }

  function sniffKind(u8, nameKind, mime) {
    if (isPdfBytes(u8)) return "pdf";
    if (isOleBytes(u8)) return "doc";
    if (isRtfBytes(u8)) return "rtf";
    if (isDjvuBytes(u8)) return "djvu";
    if (isZipBytes(u8)) return sniffZipKind(u8, nameKind);
    if (isImageBytes(u8) || (mime && mime.indexOf("image/") === 0 && nameKind !== "djvu")) return "image";
    if (isHtmlBytes(u8)) return "html";
    if (isWord2003XmlBytes(u8) || isXmlBytes(u8)) return "xml";
    if (nameKind === "csv" || nameKind === "markdown" || nameKind === "text") return nameKind;
    if (nameKind && nameKind !== "docx" && nameKind !== "doc" &&
        nameKind !== "odt" && nameKind !== "ods" && nameKind !== "odp" && nameKind !== "odg" && nameKind !== "epub") {
      return nameKind;
    }
    return "text";
  }

  function mapZipError(err) {
    var msg = (err && err.message) ? String(err.message) : String(err || "");
    if (ZIP_FAIL_RE.test(msg) || /central directory/i.test(msg)) {
      return new Error(INCOMPLETE_FILE_MSG);
    }
    return (err instanceof Error) ? err : new Error(msg || "Could not convert that file.");
  }

  async function loadZip(buf) {
    var u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (!isZipBytes(u8) || !zipHasEndRecord(u8)) {
      throw new Error(INCOMPLETE_FILE_MSG);
    }
    try {
      return await requireJSZip().loadAsync(u8);
    } catch (err) {
      throw mapZipError(err);
    }
  }

  function decodeText(u8) {
    var encs = ["utf-8", "utf-16le", "windows-1252"];
    var i, dec, s;
    for (i = 0; i < encs.length; i++) {
      try {
        dec = new TextDecoder(encs[i], { fatal: encs[i] === "utf-8" });
        s = dec.decode(u8);
        if (s.indexOf("\uFFFD") === -1 || encs[i] !== "utf-8") return s;
      } catch (e) {}
    }
    try { return new TextDecoder("utf-8", { fatal: false }).decode(u8); } catch (e2) {}
    if (u8 && u8.length > 2000000) return "";
    s = "";
    for (i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return s;
  }

  function jpegInfo(bytes) {
    if (!bytes || bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) return null;
    var i = 2, m, len, h, w, comp;
    while (i < bytes.length - 8) {
      if (bytes[i] !== 0xFF) { i++; continue; }
      m = bytes[i + 1];
      if (m === 0xD8 || m === 0xD9 || m === 0x00) { i++; continue; }
      if (m >= 0xD0 && m <= 0xD7) { i += 2; continue; }
      if (m === 0xDA) break;
      len = (bytes[i + 2] << 8) | bytes[i + 3];
      if (len < 2) break;
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
        h = (bytes[i + 5] << 8) | bytes[i + 6];
        w = (bytes[i + 7] << 8) | bytes[i + 8];
        comp = bytes[i + 9];
        return { w: w, h: h, comp: comp };
      }
      i += 2 + len;
    }
    return null;
  }

  function buildPdfFromJpegPages(pages) {
    if (!pages || !pages.length) throw new Error("No pages to save.");
    var parts = [];
    var length = 0;
    var offsets = [0];
    function addBytes(u8) { parts.push(u8); length += u8.length; }
    function addStr(s) {
      var u = new Uint8Array(s.length), i;
      for (i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xFF;
      addBytes(u);
    }
    function startObj(num) { offsets[num] = length; addStr(String(num) + " 0 obj\n"); }
    function endObj() { addStr("\nendobj\n"); }
    var n = pages.length;
    var i, rec, info, w, h, cs, pageObj, contentObj, imageObj, content, kids;
    addStr("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
    startObj(1);
    addStr("<< /Type /Catalog /Pages 2 0 R >>");
    endObj();
    kids = [];
    for (i = 0; i < n; i++) kids.push(String(3 + 3 * i) + " 0 R");
    startObj(2);
    addStr("<< /Type /Pages /Kids [" + kids.join(" ") + "] /Count " + n + " >>");
    endObj();
    for (i = 0; i < n; i++) {
      rec = pages[i];
      info = jpegInfo(rec.data);
      w = rec.w || (info && info.w) || 1;
      h = rec.h || (info && info.h) || 1;
      if (!isFinite(w) || w < 1) w = 1;
      if (!isFinite(h) || h < 1) h = 1;
      cs = (info && info.comp === 1) ? "/DeviceGray" : (info && info.comp === 4) ? "/DeviceCMYK" : "/DeviceRGB";
      pageObj = 3 + 3 * i;
      contentObj = 4 + 3 * i;
      imageObj = 5 + 3 * i;
      content = "q\n" + w + " 0 0 " + h + " 0 0 cm\n/Im0 Do\nQ\n";
      startObj(pageObj);
      addStr("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + w + " " + h + "] /Resources << /XObject << /Im0 " + imageObj + " 0 R >> >> /Contents " + contentObj + " 0 R >>");
      endObj();
      startObj(contentObj);
      addStr("<< /Length " + content.length + " >>\nstream\n" + content + "endstream");
      endObj();
      startObj(imageObj);
      addStr("<< /Type /XObject /Subtype /Image /Width " + (info && info.w ? info.w : w) + " /Height " + (info && info.h ? info.h : h) + " /ColorSpace " + cs + " /BitsPerComponent 8 /Filter /DCTDecode /Length " + rec.data.length + " >>\nstream\n");
      addBytes(rec.data);
      addStr("\nendstream");
      endObj();
    }
    var xrefAt = length;
    var totalObjs = 2 + 3 * n;
    addStr("xref\n0 " + (totalObjs + 1) + "\n");
    addStr("0000000000 65535 f \n");
    for (i = 1; i <= totalObjs; i++) {
      addStr(("0000000000" + offsets[i]).slice(-10) + " 00000 n \n");
    }
    addStr("trailer\n<< /Size " + (totalObjs + 1) + " /Root 1 0 R >>\nstartxref\n" + xrefAt + "\n%%EOF\n");
    var out = new Uint8Array(length), o = 0;
    for (i = 0; i < parts.length; i++) { out.set(parts[i], o); o += parts[i].length; }
    return new Blob([out], { type: "application/pdf" });
  }

  function canvasToJpegBytes(canvas, quality) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (!blob) { reject(new Error("Could not encode a page image.")); return; }
        blob.arrayBuffer().then(function (buf) { resolve(new Uint8Array(buf)); }, reject);
      }, "image/jpeg", quality == null ? JPEG_QUALITY : quality);
    });
  }

  function makePageCanvas(px) {
    var c = document.createElement("canvas");
    c.width = px.w;
    c.height = px.h;
    var ctx = c.getContext("2d", { alpha: false });
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, px.w, px.h);
    ctx.fillStyle = "#111111";
    return { canvas: c, ctx: ctx };
  }

  async function layoutTextToPages(text, opts) {
    opts = opts || {};
    var px = pagePixels(opts.pageSize, opts.landscape);
    var margin = Math.round((opts.marginPt || 54) * RENDER_DPI / 72);
    var fontSize = Math.round((opts.fontPt || 11) * RENDER_DPI / 72);
    var lineH = Math.round(fontSize * (opts.lineHeight || 1.35));
    var mono = !!opts.mono;
    var font = (mono ? "500 " : "400 ") + fontSize + "px " + (mono ? "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" : "Georgia, \"Times New Roman\", Times, serif");
    var maxW = Math.max(20, px.w - 2 * margin);
    var maxY = px.h - margin;
    var pages = [];
    var box = makePageCanvas(px);
    var ctx = box.ctx;
    ctx.font = font;
    ctx.textBaseline = "top";
    var x = margin, y = margin;
    var raw = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    var omittedLarge = false;
    if (raw.length > MAX_TEXT_CHARS) {
      raw = raw.slice(0, MAX_TEXT_CHARS);
      omittedLarge = true;
    }
    var paragraphs = raw.split("\n");
    var i, para, words, w, line, test, ch, j, chunk;
    function newPage() {
      return canvasToJpegBytes(box.canvas).then(function (data) {
        pages.push({ data: data, w: px.wPt, h: px.hPt });
        box = makePageCanvas(px);
        ctx = box.ctx;
        ctx.font = font;
        ctx.textBaseline = "top";
        y = margin;
        x = margin;
      });
    }
    for (i = 0; i < paragraphs.length; i++) {
      if (pages.length >= MAX_TEXT_PAGES) { omittedLarge = true; break; }
      para = paragraphs[i];
      if (y + lineH > maxY) await newPage();
      if (para === "") { y += Math.round(lineH * 0.6); continue; }
      // Preserve long unspaced lines by character wrapping when needed
      words = para.split(/(\s+)/);
      line = "";
      for (j = 0; j < words.length; j++) {
        w = words[j];
        test = line + w;
        if (ctx.measureText(test).width <= maxW) {
          line = test;
          continue;
        }
        if (line) {
          if (y + lineH > maxY) await newPage();
          ctx.fillText(line.replace(/\s+$/, ""), margin, y);
          y += lineH;
          line = "";
        }
        if (ctx.measureText(w).width <= maxW) {
          line = w.replace(/^\s+/, "");
          continue;
        }
        chunk = "";
        for (ch = 0; ch < w.length; ch++) {
          if (ctx.measureText(chunk + w.charAt(ch)).width > maxW && chunk) {
            if (y + lineH > maxY) await newPage();
            ctx.fillText(chunk, margin, y);
            y += lineH;
            chunk = w.charAt(ch);
          } else chunk += w.charAt(ch);
        }
        line = chunk;
      }
      if (line) {
        if (y + lineH > maxY) await newPage();
        ctx.fillText(line.replace(/\s+$/, ""), margin, y);
        y += lineH;
      }
      if (i % 80 === 0) {
        if (opts.onProgress) opts.onProgress("Converting… page " + (pages.length + 1));
        await yieldTick();
      }
    }
    if (omittedLarge) {
      if (y + lineH > maxY) await newPage();
      ctx.fillText("The rest of this file was omitted because it is very large.", margin, y);
      y += lineH;
    }
    if (pages.length === 0 || y > margin) {
      pages.push({ data: await canvasToJpegBytes(box.canvas), w: px.wPt, h: px.hPt });
    }
    try { box.canvas.width = 1; box.canvas.height = 1; } catch (e) {}
    return pages;
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function markdownToHtml(md) {
    var s = escapeHtml(md);
    s = s.replace(/```([\s\S]*?)```/g, function (_, code) {
      return "<pre>" + code + "</pre>";
    });
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    s = s.replace(/^######\s+(.+)$/gm, "<h6>$1</h6>");
    s = s.replace(/^#####\s+(.+)$/gm, "<h5>$1</h5>");
    s = s.replace(/^####\s+(.+)$/gm, "<h4>$1</h4>");
    s = s.replace(/^###\s+(.+)$/gm, "<h3>$1</h3>");
    s = s.replace(/^##\s+(.+)$/gm, "<h2>$1</h2>");
    s = s.replace(/^#\s+(.+)$/gm, "<h1>$1</h1>");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    s = s.replace(/(^|\W)\*([^*]+)\*(?=\W|$)/g, "$1<em>$2</em>");
    s = s.replace(/^\s*[-*]\s+(.+)$/gm, "<li>$1</li>");
    s = s.replace(/(<li>[\s\S]*?<\/li>)/g, "<ul>$1</ul>");
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<span>$1</span>");
    var parts = s.split(/\n{2,}/);
    return parts.map(function (p) {
      if (/^\s*<(h[1-6]|ul|pre|ol)/.test(p)) return p;
      return "<p>" + p.replace(/\n/g, "<br>") + "</p>";
    }).join("");
  }

  function rtfToText(rtf) {
    var s = String(rtf || "");
    s = s.replace(/\{\\*\\[^{}]*\}/g, "");
    s = s.replace(/\\'[0-9a-fA-F]{2}/g, function (m) {
      return String.fromCharCode(parseInt(m.slice(2), 16));
    });
    s = s.replace(/\\u(-?\d+)\??/g, function (_, n) {
      var code = parseInt(n, 10);
      if (code < 0) code += 65536;
      return String.fromCharCode(code);
    });
    s = s.replace(/\\par[d]?/g, "\n");
    s = s.replace(/\\tab/g, "\t");
    s = s.replace(/\\line/g, "\n");
    s = s.replace(/\\[a-zA-Z]+-?\d* ?/g, "");
    s = s.replace(/[{}]/g, "");
    s = s.replace(/\\([\\{}])/g, "$1");
    return s.replace(/\n{3,}/g, "\n\n").trim();
  }

  function csvToHtml(text) {
    var lines = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    var rows = [], i, line, cells, cell, inQ, ch, j;
    for (i = 0; i < lines.length; i++) {
      line = lines[i];
      if (i === lines.length - 1 && line === "") continue;
      cells = []; cell = ""; inQ = false;
      for (j = 0; j < line.length; j++) {
        ch = line.charAt(j);
        if (inQ) {
          if (ch === '"') {
            if (line.charAt(j + 1) === '"') { cell += '"'; j++; }
            else inQ = false;
          } else cell += ch;
        } else if (ch === '"') inQ = true;
        else if (ch === ",") { cells.push(cell); cell = ""; }
        else cell += ch;
      }
      cells.push(cell);
      rows.push(cells);
    }
    var html = "<table>";
    for (i = 0; i < rows.length; i++) {
      html += i === 0 ? "<thead><tr>" : (i === 1 ? "</thead><tbody><tr>" : "<tr>");
      var tag = i === 0 ? "th" : "td";
      for (j = 0; j < rows[i].length; j++) html += "<" + tag + ">" + escapeHtml(rows[i][j]) + "</" + tag + ">";
      html += "</tr>";
    }
    if (rows.length) html += rows.length === 1 ? "</thead>" : "</tbody>";
    html += "</table>";
    return html;
  }

  function xmlToText(xml) {
    try {
      var doc = new DOMParser().parseFromString(String(xml), "application/xml");
      if (doc.querySelector("parsererror")) return String(xml);
      var txt = (doc.documentElement && doc.documentElement.textContent) || "";
      txt = txt.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
      return txt || String(xml);
    } catch (e) {
      return String(xml);
    }
  }

  function stripDangerousHtml(html) {
    return String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, function (m) { return m; })
      .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
      .replace(/<object[\s\S]*?<\/object>/gi, "")
      .replace(/<embed[\s\S]*?>/gi, "")
      .replace(/<link[\s\S]*?>/gi, "")
      .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
      .replace(/javascript:/gi, "")
      .replace(/data:text\/html/gi, "data:text/plain");
  }

  function pageCss(px, margin) {
    return "#pr-sheet{box-sizing:border-box;padding:" + margin + "px;width:" + px.w + "px;" +
      "margin:0;background:#fff;color:#111;" +
      "font:16px/1.4 Georgia,'Times New Roman',Times,serif;}" +
      "#pr-sheet h1,#pr-sheet h2,#pr-sheet h3,#pr-sheet h4{font-family:Georgia,serif;margin:0.8em 0 0.4em;}" +
      "#pr-sheet p{margin:0 0 0.7em;}" +
      "#pr-sheet pre,#pr-sheet code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;}" +
      "#pr-sheet pre{white-space:pre-wrap;word-wrap:break-word;}" +
      "#pr-sheet table{border-collapse:collapse;width:100%;font-size:12px;margin:0 0 1em;}" +
      "#pr-sheet th,#pr-sheet td{border:1px solid #888;padding:3px 6px;vertical-align:top;text-align:left;}" +
      "#pr-sheet img{max-width:100%;height:auto;}" +
      "#pr-sheet ul,#pr-sheet ol{margin:0 0 0.7em;padding-left:1.4em;}";
  }

  async function snapshotNodeToJpeg(node, px) {
    var wrap = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
    wrap.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
    wrap.style.cssText = "width:" + px.w + "px;height:" + px.h + "px;background:#fff;overflow:hidden;margin:0;padding:0;";
    wrap.appendChild(node.cloneNode(true));
    var ser = new XMLSerializer().serializeToString(wrap);
    if (ser.indexOf("xmlns") === -1) {
      ser = ser.replace("<div", '<div xmlns="http://www.w3.org/1999/xhtml"');
    }
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + px.w + '" height="' + px.h + '">' +
      '<foreignObject width="100%" height="100%">' + ser + "</foreignObject></svg>";
    var url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
    try {
      var img = new Image();
      await new Promise(function (resolve, reject) {
        img.onload = resolve;
        img.onerror = reject;
        img.src = url;
      });
      var box = makePageCanvas(px);
      box.ctx.drawImage(img, 0, 0);
      var data = await canvasToJpegBytes(box.canvas);
      try { box.canvas.width = 1; box.canvas.height = 1; } catch (e) {}
      return data;
    } finally {
      try { URL.revokeObjectURL(url); } catch (e2) {}
    }
  }

  async function layoutHtmlToPages(html, opts) {
    opts = opts || {};
    var px = pagePixels(opts.pageSize, opts.landscape);
    var margin = Math.round((opts.marginPt || 54) * RENDER_DPI / 72);
    var host = document.createElement("div");
    host.style.cssText = "position:fixed;left:-16000px;top:0;width:" + px.w + "px;background:#fff;color:#111;z-index:-1;overflow:visible;font-family:system-ui,'Segoe UI',Arial,sans-serif;";
    var style = document.createElement("style");
    style.textContent = pageCss(px, margin);
    var sheet = document.createElement("div");
    sheet.id = "pr-sheet";
    sheet.innerHTML = stripDangerousHtml(html);
    host.appendChild(style);
    host.appendChild(sheet);
    document.body.appendChild(host);
    try {
      await yieldTick();
      var imgs = sheet.querySelectorAll("img");
      if (imgs.length) {
        await Promise.all(Array.prototype.map.call(imgs, function (im) {
          if (im.complete) return Promise.resolve();
          return new Promise(function (r) { im.onload = im.onerror = r; });
        }));
      }
      var totalH = Math.max(sheet.scrollHeight, sheet.offsetHeight);
      var contentH = px.h;
      var pages = [];
      var offset = 0;
      var pageNo = 0;
      if (totalH <= 2) throw new Error("empty-html");
      while (offset < totalH - 1) {
        pageNo += 1;
        if (opts.onProgress) opts.onProgress("Converting… page " + pageNo);
        var slice = document.createElement("div");
        slice.style.cssText = "width:" + px.w + "px;height:" + px.h + "px;overflow:hidden;background:#fff;position:relative;font-family:system-ui,'Segoe UI',Arial,sans-serif;";
        var inner = sheet.cloneNode(true);
        inner.style.marginTop = (-offset) + "px";
        slice.appendChild(style.cloneNode(true));
        slice.appendChild(inner);
        var data;
        try {
          data = await snapshotNodeToJpeg(slice, px);
        } catch (err) {
          throw err;
        }
        pages.push({ data: data, w: px.wPt, h: px.hPt });
        offset += contentH;
        if (pageNo % 3 === 0) await yieldTick();
        if (pageNo > 2500) break;
      }
      return pages;
    } finally {
      try { host.remove(); } catch (e) {}
    }
  }

  async function htmlOrTextPages(html, opts, fallbackText) {
    try {
      var pages = await layoutHtmlToPages(html, opts);
      if (pages && pages.length) return pages;
    } catch (e) {}
    return layoutTextToPages(fallbackText != null ? fallbackText : htmlToPlain(html), opts);
  }

  function htmlToPlain(html) {
    var d = document.createElement("div");
    d.innerHTML = stripDangerousHtml(html);
    return (d.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
  }

  async function imagesToPages(filesOrBlobs, opts) {
    var px = pagePixels(opts && opts.pageSize, opts && opts.landscape);
    var margin = Math.round(36 * RENDER_DPI / 72);
    var pages = [];
    var i, img, url, iw, ih, scale, dw, dh, dx, dy, box;
    for (i = 0; i < filesOrBlobs.length; i++) {
      url = URL.createObjectURL(filesOrBlobs[i]);
      try {
        img = new Image();
        await new Promise(function (resolve, reject) { img.onload = resolve; img.onerror = reject; img.src = url; });
        iw = img.naturalWidth || img.width;
        ih = img.naturalHeight || img.height;
        if (!iw || !ih) throw new Error("The image has no size.");
        scale = Math.min((px.w - 2 * margin) / iw, (px.h - 2 * margin) / ih);
        dw = Math.max(1, Math.round(iw * scale));
        dh = Math.max(1, Math.round(ih * scale));
        dx = Math.round((px.w - dw) / 2);
        dy = Math.round((px.h - dh) / 2);
        box = makePageCanvas(px);
        box.ctx.drawImage(img, dx, dy, dw, dh);
        pages.push({ data: await canvasToJpegBytes(box.canvas), w: px.wPt, h: px.hPt });
        try { box.canvas.width = 1; box.canvas.height = 1; } catch (e) {}
      } finally {
        try { URL.revokeObjectURL(url); } catch (e2) {}
      }
    }
    return pages;
  }

  async function blobFromZip(zip, path) {
    var f = zip.file(path) || zip.file(path.replace(/^\//, ""));
    if (!f) return null;
    var buf = await f.async("arraybuffer");
    return new Blob([buf]);
  }

  function requireJSZip() {
    if (!root.JSZip) throw new Error("JSZip is missing. Keep jszip.min.js in the same folder as this reader.");
    return root.JSZip;
  }

  async function docxToHtml(buf) {
    if (!root.mammoth || !root.mammoth.convertToHtml) {
      throw new Error("mammoth.js is missing. Keep mammoth.browser.min.js in the same folder as this reader.");
    }
    var u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (!isZipBytes(u8) || !zipHasEndRecord(u8)) {
      throw new Error(INCOMPLETE_FILE_MSG);
    }
    var result;
    try {
      result = await root.mammoth.convertToHtml({ arrayBuffer: asArrayBuffer(buf) }, {
        convertImage: root.mammoth.images.inline(function (el) {
          return el.read("base64").then(function (b64) {
            return { src: "data:" + el.contentType + ";base64," + b64 };
          });
        })
      });
    } catch (err) {
      throw mapZipError(err);
    }
    return result.value || "<p></p>";
  }

  function extractPrintable(u8) {
    var chunks = [], cur = "", i, c, s;
    // 8-bit runs
    for (i = 0; i < u8.length; i++) {
      c = u8[i];
      if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127)) cur += String.fromCharCode(c === 13 ? 10 : c);
      else {
        if (cur.length >= 40) chunks.push(cur);
        cur = "";
      }
    }
    if (cur.length >= 40) chunks.push(cur);
    // UTF-16LE runs
    cur = "";
    for (i = 0; i + 1 < u8.length; i += 2) {
      c = u8[i] | (u8[i + 1] << 8);
      if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 0xD800)) cur += String.fromCharCode(c === 13 ? 10 : c);
      else {
        if (cur.length >= 40) chunks.push(cur);
        cur = "";
      }
    }
    if (cur.length >= 40) chunks.push(cur);
    s = chunks.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    return s;
  }

  function docToText(buf) {
    var u8 = new Uint8Array(buf);
    var text = extractPrintable(u8);
    if (!text || text.length < 20) {
      throw new Error("This .doc file could not be read. Please save it as .docx and try again.");
    }
    return "This older Word (.doc) file was opened as extracted text.\n\n" + text;
  }

  function xmlNsLocal(el) {
    return (el.localName || el.nodeName || "").replace(/^.*:/, "");
  }

  async function odfToHtml(buf, kind, zip) {
    var JSZip = requireJSZip();
    zip = zip || await loadZip(buf);
    var file = zip.file("content.xml");
    if (!file) throw new Error("This OpenDocument file has no content.xml.");
    var xml = await file.async("string");
    var doc = new DOMParser().parseFromString(xml, "application/xml");
    if (doc.querySelector("parsererror")) throw new Error("This OpenDocument file could not be parsed.");

    async function imageSrc(href) {
      if (!href) return "";
      href = href.replace(/^\.\//, "");
      var blob = await blobFromZip(zip, href);
      if (!blob) return "";
      var typ = "image/png";
      if (/\.jpe?g$/i.test(href)) typ = "image/jpeg";
      else if (/\.gif$/i.test(href)) typ = "image/gif";
      else if (/\.svg$/i.test(href)) typ = "image/svg+xml";
      var b64 = btoa(String.fromCharCode.apply(null, new Uint8Array(await blob.arrayBuffer()).subarray(0, 0))); // placeholder
      var u8 = new Uint8Array(await blob.arrayBuffer());
      var chunk = 0x8000, s = "", i;
      for (i = 0; i < u8.length; i += chunk) {
        s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
      }
      return "data:" + typ + ";base64," + btoa(s);
    }

    async function walk(node) {
      var i, out = "", child, name, nrep, rrep, j, k, href, src, level, tag;
      if (!node) return "";
      if (node.nodeType === 3) return escapeHtml(node.nodeValue || "");
      if (node.nodeType !== 1) return "";
      name = xmlNsLocal(node);
      if (name === "p" || name === "h") {
        level = parseInt(node.getAttribute("text:outline-level") || node.getAttribute("outline-level") || "1", 10);
        tag = name === "h" ? ("h" + Math.min(6, Math.max(1, level))) : "p";
        out = "<" + tag + ">";
        for (i = 0; i < node.childNodes.length; i++) out += await walk(node.childNodes[i]);
        return out + "</" + tag + ">";
      }
      if (name === "s") {
        nrep = parseInt(node.getAttribute("text:c") || node.getAttribute("c") || "1", 10);
        return new Array(Math.max(1, nrep) + 1).join(" ");
      }
      if (name === "tab") return "\t";
      if (name === "line-break" || name === "line-break") return "<br>";
      if (name === "a" || name === "span" || name === "sequence") {
        for (i = 0; i < node.childNodes.length; i++) out += await walk(node.childNodes[i]);
        return out;
      }
      if (name === "list") {
        out = "<ul>";
        for (i = 0; i < node.childNodes.length; i++) out += await walk(node.childNodes[i]);
        return out + "</ul>";
      }
      if (name === "list-item") {
        out = "<li>";
        for (i = 0; i < node.childNodes.length; i++) out += await walk(node.childNodes[i]);
        return out + "</li>";
      }
      if (name === "table") {
        out = "<table>";
        for (i = 0; i < node.childNodes.length; i++) out += await walk(node.childNodes[i]);
        return out + "</table>";
      }
      if (name === "table-row") {
        rrep = parseInt(node.getAttribute("table:number-rows-repeated") || node.getAttribute("number-rows-repeated") || "1", 10);
        out = "<tr>";
        for (i = 0; i < node.childNodes.length; i++) out += await walk(node.childNodes[i]);
        out += "</tr>";
        if (rrep > 1 && rrep < 80) {
          var one = out;
          for (k = 1; k < rrep; k++) out += one;
        }
        return out;
      }
      if (name === "table-cell" || name === "covered-table-cell") {
        nrep = parseInt(node.getAttribute("table:number-columns-repeated") || node.getAttribute("number-columns-repeated") || "1", 10);
        if (nrep > 40) nrep = 40;
        out = "<td>";
        for (i = 0; i < node.childNodes.length; i++) out += await walk(node.childNodes[i]);
        out += "</td>";
        var cells = "";
        for (k = 0; k < Math.max(1, nrep); k++) cells += out;
        return cells;
      }
      if (name === "image") {
        href = node.getAttribute("xlink:href") || node.getAttribute("href") || "";
        src = await imageSrc(href);
        return src ? '<p><img src="' + src + '" alt=""></p>' : "";
      }
      if (name === "page" && (kind === "odp" || kind === "odg")) {
        out = '<div style="page-break-before:always;margin-bottom:24px;border-bottom:1px solid #ccc;padding-bottom:16px;">';
        for (i = 0; i < node.childNodes.length; i++) out += await walk(node.childNodes[i]);
        return out + "</div>";
      }
      if (name === "table" && kind === "ods") {
        var tname = node.getAttribute("table:name") || node.getAttribute("name") || "Sheet";
        out = "<h2>" + escapeHtml(tname) + "</h2><table>";
        for (i = 0; i < node.childNodes.length; i++) out += await walk(node.childNodes[i]);
        return out + "</table>";
      }
      for (i = 0; i < node.childNodes.length; i++) out += await walk(node.childNodes[i]);
      return out;
    }

    var html = await walk(doc.documentElement);
    return html || "<p></p>";
  }

  async function epubToHtml(buf) {
    var JSZip = requireJSZip();
    var zip = await loadZip(buf);
    var container = zip.file("META-INF/container.xml");
    if (!container) throw new Error("This EPUB has no container.xml.");
    var cxml = await container.async("string");
    var cdoc = new DOMParser().parseFromString(cxml, "application/xml");
    var rootfile = cdoc.querySelector("rootfile");
    var opfPath = rootfile && (rootfile.getAttribute("full-path") || "");
    if (!opfPath) throw new Error("This EPUB has no package file.");
    var opfFile = zip.file(opfPath);
    if (!opfFile) throw new Error("This EPUB package file is missing.");
    var opf = await opfFile.async("string");
    var odoc = new DOMParser().parseFromString(opf, "application/xml");
    var base = opfPath.replace(/[^/]+$/, "");
    var manifest = {};
    var items = odoc.querySelectorAll("item, manifest > item");
    var i, id, href, typ;
    for (i = 0; i < items.length; i++) {
      id = items[i].getAttribute("id");
      href = items[i].getAttribute("href");
      typ = items[i].getAttribute("media-type") || "";
      if (id && href) manifest[id] = { href: base + href, type: typ };
    }
    var spine = odoc.querySelectorAll("spine itemref");
    var html = "";
    async function rewriteImages(xhtml, path) {
      var dir = path.replace(/[^/]+$/, "");
      var matches = [];
      xhtml.replace(/src=["']([^"']+)["']/g, function (m, src) {
        matches.push(src); return m;
      });
      var j, src, resolved, blob, u8, s, k, chunk, typ2, data;
      for (j = 0; j < matches.length; j++) {
        src = matches[j];
        if (/^data:|^https?:/i.test(src)) continue;
        resolved = (dir + src).replace(/\/\.\//g, "/");
        while (resolved.indexOf("/../") >= 0) resolved = resolved.replace(/[^/]+\/\.\.\//, "");
        blob = await blobFromZip(zip, resolved);
        if (!blob) continue;
        u8 = new Uint8Array(await blob.arrayBuffer());
        typ2 = "image/jpeg";
        if (/\.png$/i.test(src)) typ2 = "image/png";
        else if (/\.gif$/i.test(src)) typ2 = "image/gif";
        else if (/\.svg$/i.test(src)) typ2 = "image/svg+xml";
        s = ""; chunk = 0x8000;
        for (k = 0; k < u8.length; k += chunk) s += String.fromCharCode.apply(null, u8.subarray(k, k + chunk));
        data = "data:" + typ2 + ";base64," + btoa(s);
        xhtml = xhtml.split(src).join(data);
      }
      return xhtml;
    }
    for (i = 0; i < spine.length; i++) {
      id = spine[i].getAttribute("idref");
      if (!manifest[id]) continue;
      typ = manifest[id].type;
      if (typ && typ.indexOf("html") === -1 && typ.indexOf("xml") === -1) continue;
      var part = zip.file(manifest[id].href);
      if (!part) continue;
      var xhtml = await part.async("string");
      xhtml = await rewriteImages(xhtml, manifest[id].href);
      var body = xhtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      html += "<div class='epub-chapter'>" + stripDangerousHtml(body ? body[1] : xhtml) + "</div>";
    }
    if (!html) throw new Error("This EPUB had no readable chapters.");
    return html;
  }

  async function djvuToPages(buf, opts) {
    if (!root.DjVu || !root.DjVu.Document) {
      throw new Error("DjVu.js is missing. Keep djvu.js in the same folder as this reader.");
    }
    var doc = new root.DjVu.Document(buf);
    var n = doc.getPagesQuantity ? doc.getPagesQuantity() : 0;
    if (!n) throw new Error("This DjVu file has no pages.");
    var pages = [], i, page, img, dpi, wPt, hPt, c, ctx, maxEdge, scale, dw, dh;
    for (i = 1; i <= n; i++) {
      if (opts && opts.onProgress) opts.onProgress("Converting DjVu… page " + i + "/" + n);
      page = await doc.getPage(i);
      img = page.getImageData(true);
      dpi = page.getDpi ? (page.getDpi() || 300) : 300;
      wPt = img.width * 72 / dpi;
      hPt = img.height * 72 / dpi;
      // Keep native size, but cap very large rasters for memory.
      maxEdge = 2400;
      scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
      dw = Math.max(1, Math.round(img.width * scale));
      dh = Math.max(1, Math.round(img.height * scale));
      c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      ctx = c.getContext("2d", { alpha: false });
      ctx.putImageData(img, 0, 0);
      if (scale < 1) {
        var c2 = document.createElement("canvas");
        c2.width = dw; c2.height = dh;
        c2.getContext("2d", { alpha: false }).drawImage(c, 0, 0, dw, dh);
        try { c.width = 1; c.height = 1; } catch (e) {}
        c = c2;
      }
      pages.push({ data: await canvasToJpegBytes(c), w: wPt, h: hPt });
      try { c.width = 1; c.height = 1; } catch (e2) {}
      if (page.reset) { try { page.reset(); } catch (e3) {} }
      await yieldTick();
    }
    return pages;
  }

  async function convertToPdfFile(file, opts) {
    opts = opts || {};
    var name = file.name || "document";
    var nameKind = kindOfName(name);
    var buf = await file.arrayBuffer();
    var u8 = new Uint8Array(buf);
    var kind = sniffKind(u8, nameKind, file.type || "");
    if (isPdfBytes(u8) || kind === "pdf") {
      return new File([buf], name, { type: "application/pdf" });
    }
    if (opts.onProgress) opts.onProgress("Converting " + name + "…");
    var pages;
    var pageOpts = { pageSize: opts.pageSize, onProgress: opts.onProgress, landscape: !!opts.landscape };
    try {
      if (kind === "image") {
        pages = await imagesToPages([new Blob([buf], { type: file.type || "image/png" })], pageOpts);
      } else if (kind === "djvu") {
        pages = await djvuToPages(buf, pageOpts);
      } else if (kind === "docx") {
        var html = await docxToHtml(buf);
        pages = await htmlOrTextPages(html, pageOpts, htmlToPlain(html));
      } else if (kind === "doc") {
        pages = await layoutTextToPages(docToText(buf), pageOpts);
      } else if (kind === "odt" || kind === "ods" || kind === "odp" || kind === "odg") {
        html = await odfToHtml(buf, kind);
        pages = await htmlOrTextPages(html, pageOpts, htmlToPlain(html));
      } else if (kind === "epub") {
        html = await epubToHtml(buf);
        pages = await htmlOrTextPages(html, pageOpts, htmlToPlain(html));
      } else if (kind === "rtf") {
        pages = await layoutTextToPages(rtfToText(decodeText(u8)), pageOpts);
      } else if (kind === "markdown") {
        var md = decodeText(u8);
        html = markdownToHtml(md);
        pages = await htmlOrTextPages(html, pageOpts, md);
      } else if (kind === "csv") {
        var csv = decodeText(u8);
        html = csvToHtml(csv);
        pages = await htmlOrTextPages(html, Object.assign({}, pageOpts, { mono: false }), csv);
      } else if (kind === "html") {
        html = decodeText(u8);
        var pre = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
        if (pre && pre[1] && pre[1].length > 20000) {
          var tmp = document.createElement("div");
          tmp.innerHTML = pre[1];
          pages = await layoutTextToPages(tmp.textContent || tmp.innerText || "", pageOpts);
        } else {
          pages = await htmlOrTextPages(html, pageOpts, htmlToPlain(html));
        }
      } else if (kind === "xml") {
        pages = await layoutTextToPages(xmlToText(decodeText(u8)), pageOpts);
      } else if (kind === "text" || !kind) {
        pages = await layoutTextToPages(decodeText(u8), pageOpts);
      } else {
        throw new Error("This file type is not supported.");
      }
    } catch (err) {
      throw mapZipError(err);
    }
    if (!pages || !pages.length) throw new Error("No pages could be built from that file.");
    if (opts.onProgress) opts.onProgress("Building a temporary PDF (" + pages.length + " pages)…");
    var blob = buildPdfFromJpegPages(pages);
    return new File([blob], name, { type: "application/pdf" });
  }

  root.PhotoReaderFormats = {
    ACCEPT: ACCEPT,
    pageSizeSpec: pageSizeSpec,
    pagePixels: pagePixels,
    configuredPageSizeName: configuredPageSizeName,
    extOf: extOf,
    kindOfName: kindOfName,
    isSupportedName: isSupportedName,
    isPdfName: isPdfName,
    isPdfBytes: isPdfBytes,
    sniffKind: sniffKind,
    INCOMPLETE_FILE_MSG: INCOMPLETE_FILE_MSG,
    convertToPdfFile: convertToPdfFile,
    buildPdfFromJpegPages: buildPdfFromJpegPages
  };
})(window);
