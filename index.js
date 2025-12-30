// synoptic-pdf/index.js
// PURPOSE: Professional PDF Generation Engine for Synoptic Studio
// VERSION: 2.0.0 - Full feature parity with web app

const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));

// ═══════════════════════════════════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════════════════════════════════
app.get('/health', (req, res) => res.json({ 
  status: 'ok',
  version: '2.0.0',
  engine: 'Puppeteer/Chromium',
  capabilities: ['generate', 'generate-cover', 'metadata', 'watermark']
}));

// ═══════════════════════════════════════════════════════════════════
// MAIN PDF GENERATION ENDPOINT
// ═══════════════════════════════════════════════════════════════════
app.post('/generate', async (req, res) => {
  const { 
    html, 
    css, 
    width = 152, 
    height = 229, 
    bleed = 0,
    metadata = {},
    options = {}
  } = req.body;

  // Extract options with defaults
  const resolution = options.resolution || 300;
  const colorMode = options.colorMode || 'sRGB';
  const watermark = options.watermark || false;
  const lang = options.lang || 'en';

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--font-render-hinting=none'
      ],
    });

    const page = await browser.newPage();

    // Set viewport to page dimensions (mm to pixels at specified DPI)
    // 25.4 mm = 1 inch
    const pxWidth = Math.round((width / 25.4) * resolution);
    const pxHeight = Math.round((height / 25.4) * resolution);
    await page.setViewport({ width: pxWidth, height: pxHeight, deviceScaleFactor: 1 });

    // Build watermark HTML if needed (server-side generation)
    const watermarkHTML = watermark ? `
      <div class="synoptic-watermark" style="
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%) rotate(-45deg);
        font-family: 'Spectral', serif;
        font-size: 48pt;
        font-weight: 900;
        color: rgba(48, 184, 200, 0.08);
        white-space: nowrap;
        pointer-events: none;
        z-index: 9999;
        letter-spacing: 0.1em;
      ">SYNOPTIC STUDIO</div>
    ` : '';

    // Full HTML document with proper encoding and fonts
    const fullHtml = `
      <!DOCTYPE html>
      <html lang="${lang}">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${metadata.title || 'Synoptic Export'}</title>
        <meta name="author" content="${metadata.author || ''}">
        <meta name="description" content="${metadata.subject || ''}">
        <meta name="keywords" content="${(metadata.keywords || []).join(', ')}">
        <meta name="generator" content="${metadata.creator || 'Synoptic Studio'}">
        <style>
          @page {
            size: ${width}mm ${height}mm;
            margin: 0;
          }
          * {
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
            color-adjust: exact !important;
          }
          body {
            margin: 0;
            padding: ${bleed}mm;
            background: white;
          }
          ${css}
        </style>
      </head>
      <body>
        ${watermarkHTML}
        ${html}
      </body>
      </html>
    `;

    await page.setContent(fullHtml, { 
      waitUntil: ['networkidle0', 'domcontentloaded'],
      timeout: 60000
    });

    // Wait for fonts to load
    await page.evaluateHandle('document.fonts.ready');

    // Generate PDF with full options
    const pdfOptions = {
      width: `${width}mm`,
      height: `${height}mm`,
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: false,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    };

    const pdf = await page.pdf(pdfOptions);

    // Set response headers with metadata
    const filename = (metadata.title || 'export').replace(/[^a-zA-Z0-9-_]/g, '_');
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}.pdf"`,
      'X-PDF-Title': metadata.title || '',
      'X-PDF-Author': metadata.author || '',
      'X-PDF-Creator': metadata.creator || 'Synoptic Studio',
      'X-PDF-Producer': metadata.producer || 'Synoptic Publishing Engine',
      'X-PDF-Resolution': `${resolution}dpi`,
    });
    
    res.send(pdf);

  } catch (error) {
    console.error('PDF generation error:', error);
    res.status(500).json({ 
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  } finally {
    if (browser) await browser.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// COVER GENERATION ENDPOINT
// Full spine + front + back cover for print-on-demand
// ═══════════════════════════════════════════════════════════════════
app.post('/generate-cover', async (req, res) => {
  const {
    frontCover,      // { html, css }
    backCover,       // { html, css }
    spine,           // { html, css, width (mm) }
    dimensions,      // { width, height } in mm (trim size)
    bleed = 3.175,   // Standard 1/8" bleed
    dpi = 300,
    metadata = {}
  } = req.body;

  // Calculate full cover dimensions
  // Full cover = back + spine + front + bleeds on all sides
  const spineWidth = spine?.width || 10; // Default 10mm spine
  const fullWidth = (dimensions.width * 2) + spineWidth + (bleed * 2);
  const fullHeight = dimensions.height + (bleed * 2);

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    const page = await browser.newPage();

    // Set viewport at specified DPI
    const pxWidth = Math.round((fullWidth / 25.4) * dpi);
    const pxHeight = Math.round((fullHeight / 25.4) * dpi);
    await page.setViewport({ width: pxWidth, height: pxHeight, deviceScaleFactor: 1 });

    // Build cover layout HTML
    const coverHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          @page {
            size: ${fullWidth}mm ${fullHeight}mm;
            margin: 0;
          }
          * {
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
            box-sizing: border-box;
          }
          body {
            margin: 0;
            padding: 0;
            width: ${fullWidth}mm;
            height: ${fullHeight}mm;
            display: flex;
            background: white;
          }
          .bleed-area {
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
          }
          .cover-container {
            display: flex;
            width: 100%;
            height: 100%;
            padding: ${bleed}mm;
          }
          .back-cover {
            width: ${dimensions.width}mm;
            height: ${dimensions.height}mm;
            overflow: hidden;
          }
          .spine {
            width: ${spineWidth}mm;
            height: ${dimensions.height}mm;
            overflow: hidden;
          }
          .front-cover {
            width: ${dimensions.width}mm;
            height: ${dimensions.height}mm;
            overflow: hidden;
          }
          /* Crop marks */
          .crop-marks::before,
          .crop-marks::after {
            content: '';
            position: absolute;
            border: 0.25pt solid #000;
          }
          ${frontCover?.css || ''}
          ${backCover?.css || ''}
          ${spine?.css || ''}
        </style>
      </head>
      <body>
        <div class="cover-container">
          <div class="back-cover">${backCover?.html || ''}</div>
          <div class="spine">${spine?.html || ''}</div>
          <div class="front-cover">${frontCover?.html || ''}</div>
        </div>
      </body>
      </html>
    `;

    await page.setContent(coverHtml, { 
      waitUntil: ['networkidle0', 'domcontentloaded'],
      timeout: 60000
    });

    await page.evaluateHandle('document.fonts.ready');

    const pdf = await page.pdf({
      width: `${fullWidth}mm`,
      height: `${fullHeight}mm`,
      printBackground: true,
      preferCSSPageSize: true,
    });

    const filename = (metadata.title || 'cover').replace(/[^a-zA-Z0-9-_]/g, '_');
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}_cover.pdf"`,
      'X-Cover-Dimensions': `${fullWidth}mm x ${fullHeight}mm`,
      'X-Spine-Width': `${spineWidth}mm`,
      'X-Bleed': `${bleed}mm`,
    });

    res.send(pdf);

  } catch (error) {
    console.error('Cover generation error:', error);
    res.status(500).json({ error: error.message });
  } finally {
    if (browser) await browser.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// PREVIEW ENDPOINT (Lower resolution for fast previews)
// ═══════════════════════════════════════════════════════════════════
app.post('/preview', async (req, res) => {
  const { html, css, width = 152, height = 229 } = req.body;

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page = await browser.newPage();

    // Lower resolution for previews (72 DPI)
    const pxWidth = Math.round((width / 25.4) * 72);
    const pxHeight = Math.round((height / 25.4) * 72);
    await page.setViewport({ width: pxWidth, height: pxHeight });

    const fullHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          @page { size: ${width}mm ${height}mm; margin: 0; }
          body { margin: 0; padding: 0; }
          ${css}
        </style>
      </head>
      <body>${html}</body>
      </html>
    `;

    await page.setContent(fullHtml, { waitUntil: 'networkidle0' });

    // Return PNG image for preview
    const screenshot = await page.screenshot({
      type: 'png',
      fullPage: true,
    });

    res.set({
      'Content-Type': 'image/png',
      'Cache-Control': 'no-cache',
    });
    res.send(screenshot);

  } catch (error) {
    console.error('Preview generation error:', error);
    res.status(500).json({ error: error.message });
  } finally {
    if (browser) await browser.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// SERVER STARTUP
// ═══════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║       SYNOPTIC PDF ENGINE v2.0.0                              ║
║       Running on port ${PORT}                                     ║
║                                                               ║
║       Endpoints:                                              ║
║         POST /generate      - Full PDF generation             ║
║         POST /generate-cover - Book cover generation          ║
║         POST /preview       - Quick PNG preview               ║
║         GET  /health        - Service health check            ║
╚═══════════════════════════════════════════════════════════════╝
  `);
});
