// server.js
const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Generate PDF from HTML
app.post('/generate', async (req, res) => {
  const { html, css, width, height, bleed, options } = req.body;

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();

    // Set viewport to page dimensions (mm to pixels at 300 DPI)
    // 25.4 mm = 1 inch
    const pxWidth = Math.round((width / 25.4) * 300);
    const pxHeight = Math.round((height / 25.4) * 300);
    await page.setViewport({ width: pxWidth, height: pxHeight });

    // Full HTML document
    const fullHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          @page {
            size: ${width}mm ${height}mm;
            margin: 0;
          }
          body {
            margin: 0;
            padding: ${bleed || 0}mm;
          }
          ${css}
        </style>
      </head>
      <body>${html}</body>
      </html>
    `;

    await page.setContent(fullHtml, { waitUntil: 'networkidle0' });

    const pdf = await page.pdf({
      width: `${width}mm`,
      height: `${height}mm`,
      printBackground: true,
      preferCSSPageSize: true,
    });

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="export.pdf"`,
    });
    res.send(pdf);
  } catch (error) {
    console.error('PDF generation error:', error);
    res.status(500).json({ error: error.message });
  } finally {
    await browser.close();
  }
});

// Cover PDF (special dimensions)
app.post('/generate-cover', async (req, res) => {
  const { layers, dimensions, dpi = 300 } = req.body;

  // Placeholder for cover generation logic
  res.json({ success: true, message: 'Cover generation placeholder' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PDF Engine running on port ${PORT}`));
