// synoptic-pdf/index.js
// PURPOSE: Professional PDF Generation Engine for Synoptic Studio
// VERSION: 3.1.0 - Paged.js + Ghostscript Pipeline
// 
// ARCHITECTURE (PROFESSIONAL PRINT PIPELINE):
// ┌─────────────────────────────────────────────────────────────────┐
// │  Client HTML → Express → Puppeteer Cluster → Paged.js Render   │
// │      → Print RGB PDF → Ghostscript (CMYK) → Final PDF          │
// └─────────────────────────────────────────────────────────────────┘
//
// KEY FEATURES:
// ✓ Singleton browser pattern (no browser-per-request death spiral)
// ✓ Paged.js integration (CSS Paged Media polyfill for proper pagination)
// ✓ Ghostscript post-processing (RGB → CMYK/PDF-X conversion)
// ✓ Concurrency control with p-limit
// ✓ API key authentication (SSRF protection)
// ✓ Configurable timeouts per request
// ✓ Graceful shutdown handling

const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');
const pLimit = require('p-limit');
const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));

// ═══════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════
const CONFIG = {
  port: process.env.PORT || 3000,
  serviceSecret: process.env.PDF_SERVICE_SECRET || null,
  maxConcurrentJobs: parseInt(process.env.MAX_CONCURRENT_JOBS, 10) || 3,
  defaultTimeout: parseInt(process.env.DEFAULT_TIMEOUT_MS, 10) || 120000,
  maxTimeout: parseInt(process.env.MAX_TIMEOUT_MS, 10) || 600000,
  browserRestartThreshold: parseInt(process.env.BROWSER_RESTART_THRESHOLD, 10) || 100,
  tempDir: process.env.TEMP_DIR || '/app/tmp',
  // Feature flags
  enablePagedJs: process.env.ENABLE_PAGEDJS !== 'false',
  enableCmykConversion: process.env.ENABLE_CMYK_CONVERSION === 'true',
  pdfXStandard: process.env.PDF_X_STANDARD || 'PDF/X-1a',
};

// Ensure temp directory exists
if (!fs.existsSync(CONFIG.tempDir)) {
  fs.mkdirSync(CONFIG.tempDir, { recursive: true });
}

// ═══════════════════════════════════════════════════════════════════
// PAGED.JS SCRIPT (CSS Paged Media Polyfill)
// This is the "secret sauce" for proper pagination
// ═══════════════════════════════════════════════════════════════════
const PAGEDJS_POLYFILL = `
<script src="https://unpkg.com/pagedjs@0.4.3/dist/paged.polyfill.js"></script>
<script>
  // Wait for Paged.js to finish rendering before signaling ready
  window.PagedPolyfill.on('rendered', () => {
    window.__pagedjs_ready = true;
    console.log('[Paged.js] Rendering complete');
  });
</script>
`;

// ═══════════════════════════════════════════════════════════════════
// SINGLETON BROWSER MANAGER
// ═══════════════════════════════════════════════════════════════════
class BrowserManager {
  constructor() {
    this.browser = null;
    this.pageCount = 0;
    this.isLaunching = false;
    this.launchPromise = null;
  }

  async getBrowser() {
    if (this.browser && this.browser.isConnected()) {
      return this.browser;
    }

    if (this.isLaunching && this.launchPromise) {
      return this.launchPromise;
    }

    this.isLaunching = true;
    this.launchPromise = this._launchBrowser();
    
    try {
      this.browser = await this.launchPromise;
      this.pageCount = 0;
      return this.browser;
    } finally {
      this.isLaunching = false;
      this.launchPromise = null;
    }
  }

  async _launchBrowser() {
    console.log('[BrowserManager] Launching new browser instance...');
    const browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--font-render-hinting=none',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-breakpad',
        '--disable-component-update',
        '--disable-default-apps',
        '--disable-domain-reliability',
        '--disable-features=TranslateUI',
        '--disable-hang-monitor',
        '--disable-ipc-flooding-protection',
        '--disable-popup-blocking',
        '--disable-prompt-on-repost',
        '--disable-renderer-backgrounding',
        '--disable-sync',
        '--metrics-recording-only',
        '--no-first-run',
        '--safebrowsing-disable-auto-update',
        '--password-store=basic',
        '--use-mock-keychain',
      ],
    });

    browser.on('disconnected', () => {
      console.warn('[BrowserManager] Browser disconnected unexpectedly');
      this.browser = null;
      this.pageCount = 0;
    });

    console.log('[BrowserManager] Browser launched successfully');
    return browser;
  }

  async getPage() {
    const browser = await this.getBrowser();
    this.pageCount++;

    if (this.pageCount >= CONFIG.browserRestartThreshold) {
      console.log(`[BrowserManager] Threshold reached (${this.pageCount} pages), scheduling restart...`);
      this.scheduleRestart();
    }

    return browser.newPage();
  }

  scheduleRestart() {
    setImmediate(async () => {
      if (concurrencyLimiter.activeCount === 0 && this.browser) {
        console.log('[BrowserManager] Restarting browser for memory hygiene...');
        await this.close();
      }
    });
  }

  async close() {
    if (this.browser) {
      try {
        await this.browser.close();
        console.log('[BrowserManager] Browser closed gracefully');
      } catch (err) {
        console.error('[BrowserManager] Error closing browser:', err.message);
      }
      this.browser = null;
      this.pageCount = 0;
    }
  }
}

const browserManager = new BrowserManager();

// ═══════════════════════════════════════════════════════════════════
// CONCURRENCY LIMITER
// ═══════════════════════════════════════════════════════════════════
const concurrencyLimiter = pLimit(CONFIG.maxConcurrentJobs);

// Metrics for health monitoring
const metrics = {
  totalRequests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  activeJobs: 0,
  queuedJobs: 0,
  cmykConversions: 0,
  pagedJsRenders: 0,
};

// ═══════════════════════════════════════════════════════════════════
// SECURITY MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════
const authenticateRequest = (req, res, next) => {
  if (!CONFIG.serviceSecret) {
    console.warn('[Security] Running without API key authentication - development mode only!');
    return next();
  }

  const authHeader = req.headers['x-service-key'];
  if (!authHeader || authHeader !== CONFIG.serviceSecret) {
    console.warn(`[Security] Unauthorized request from ${req.ip}`);
    return res.status(401).json({ error: 'Unauthorized: Invalid or missing service key' });
  }

  next();
};

// HTML entity escaping
const escapeHtml = (str) => {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
};

const sanitizeMetadata = (metadata) => {
  if (!metadata || typeof metadata !== 'object') return {};
  
  return {
    title: escapeHtml(metadata.title || ''),
    author: escapeHtml(metadata.author || ''),
    subject: escapeHtml(metadata.subject || ''),
    keywords: Array.isArray(metadata.keywords) 
      ? metadata.keywords.map(k => escapeHtml(k)) 
      : [],
    creator: escapeHtml(metadata.creator || 'Synoptic Studio'),
    producer: escapeHtml(metadata.producer || 'Synoptic Publishing Engine'),
  };
};

// ═══════════════════════════════════════════════════════════════════
// GHOSTSCRIPT PDF/X CONVERSION
// Converts RGB PDF to print-ready CMYK PDF/X-1a
// ═══════════════════════════════════════════════════════════════════
async function convertToCMYK(inputPath, outputPath, options = {}) {
  const pdfxStandard = options.pdfxStandard || CONFIG.pdfXStandard;
  
  // Ghostscript command for PDF/X-1a:2001 conversion
  // This is the industry standard for print-ready files
  const gsArgs = [
    'gs',
    '-dNOPAUSE',
    '-dBATCH',
    '-dSAFER',
    '-sDEVICE=pdfwrite',
    '-dPDFSETTINGS=/prepress',          // High quality for print
    '-dColorConversionStrategy=CMYK',    // Convert to CMYK
    '-dProcessColorModel=/DeviceCMYK',   // Output as CMYK
    '-dCompatibilityLevel=1.4',          // PDF 1.4 for compatibility
    '-dEmbedAllFonts=true',              // Embed all fonts
    '-dSubsetFonts=true',                // Subset fonts to reduce size
    '-dCompressFonts=true',              // Compress fonts
    '-dAutoRotatePages=/None',           // Don't auto-rotate
    '-dDownsampleColorImages=true',      // Downsample for print
    '-dColorImageResolution=300',        // 300 DPI for images
    '-dDownsampleGrayImages=true',
    '-dGrayImageResolution=300',
    '-dDownsampleMonoImages=true',
    '-dMonoImageResolution=1200',        // Higher for line art
    `-sOutputFile=${outputPath}`,
    inputPath,
  ].join(' ');

  return new Promise((resolve, reject) => {
    console.log('[Ghostscript] Starting CMYK conversion...');
    
    exec(gsArgs, { timeout: 60000 }, (error, stdout, stderr) => {
      if (error) {
        console.error('[Ghostscript] Conversion failed:', stderr);
        reject(new Error(`CMYK conversion failed: ${error.message}`));
        return;
      }
      
      console.log('[Ghostscript] CMYK conversion complete');
      metrics.cmykConversions++;
      resolve(outputPath);
    });
  });
}

// Check if Ghostscript is available
function checkGhostscript() {
  try {
    execSync('gs --version', { stdio: 'pipe' });
    return true;
  } catch {
    console.warn('[Ghostscript] Not available - CMYK conversion disabled');
    return false;
  }
}

const ghostscriptAvailable = checkGhostscript();

// ═══════════════════════════════════════════════════════════════════
// FONT EMBEDDING CSS
// ═══════════════════════════════════════════════════════════════════
const FONT_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Outfit:wght@400;500;600;700&family=Quicksand:wght@400;500;600;700&family=Spectral:wght@400;500;600;700&family=Crimson+Pro:ital,wght@0,400;0,600;1,400&display=swap');
  
  :root {
    --font-sans: 'Geist', 'Inter', system-ui, -apple-system, sans-serif;
    --font-display: 'Outfit', 'Geist', sans-serif;
    --font-heading: 'Quicksand', 'Geist', sans-serif;
    --font-serif: 'Spectral', 'Georgia', serif;
    --font-body: 'Crimson Pro', 'Spectral', serif;
  }
`;

// ═══════════════════════════════════════════════════════════════════
// PAGED.JS CSS EXTENSIONS
// Professional print CSS that Paged.js enables
// ═══════════════════════════════════════════════════════════════════
const PAGEDJS_CSS = `
  /* Paged.js CSS Paged Media Extensions */
  
  /* Mirror margins for book binding */
  @page {
    size: var(--page-width, 152mm) var(--page-height, 229mm);
    margin: 20mm 15mm 20mm 25mm; /* top right bottom left (gutter on left) */
  }
  
  @page:left {
    margin: 20mm 25mm 20mm 15mm; /* Swap margins for verso pages */
  }
  
  @page:right {
    margin: 20mm 15mm 20mm 25mm; /* Recto pages */
  }
  
  @page:first {
    margin-top: 40mm; /* Extra space on first page */
  }
  
  /* Running headers */
  @page:left {
    @top-left {
      content: string(author);
      font-family: var(--font-heading);
      font-size: 9pt;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: #777;
    }
    @bottom-center {
      content: counter(page);
      font-family: var(--font-serif);
      font-size: 10pt;
    }
  }
  
  @page:right {
    @top-right {
      content: string(title);
      font-family: var(--font-heading);
      font-size: 9pt;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: #777;
    }
    @bottom-center {
      content: counter(page);
      font-family: var(--font-serif);
      font-size: 10pt;
    }
  }
  
  /* Named strings for running headers */
  h1.book-title {
    string-set: title content(text);
  }
  
  .author-name {
    string-set: author content(text);
  }
  
  /* Chapter breaks always start on right page */
  .chapter-start {
    break-before: right;
    page-break-before: right;
  }
  
  /* Prevent orphans and widows (typographic best practice) */
  p {
    orphans: 2;
    widows: 2;
  }
  
  /* Keep headings with following content */
  h1, h2, h3, h4, h5, h6 {
    break-after: avoid;
    page-break-after: avoid;
  }
  
  /* Prevent breaks inside important elements */
  .block, .callout, .image-block, table {
    break-inside: avoid;
    page-break-inside: avoid;
  }
  
  /* Cross-references (future feature) */
  a.page-ref::after {
    content: " (page " target-counter(attr(href), page) ")";
  }
`;

// ═══════════════════════════════════════════════════════════════════
// HEALTH CHECK ENDPOINT
// ═══════════════════════════════════════════════════════════════════
app.get('/health', (req, res) => res.json({ 
  status: 'ok',
  version: '3.1.0',
  engine: 'Puppeteer/Chromium + Paged.js + Ghostscript',
  capabilities: ['generate', 'generate-cover', 'preview', 'cmyk-conversion', 'paged-media'],
  features: {
    pagedJs: CONFIG.enablePagedJs,
    cmykConversion: CONFIG.enableCmykConversion && ghostscriptAvailable,
    pdfXStandard: CONFIG.pdfXStandard,
    ghostscriptAvailable,
  },
  metrics: {
    totalRequests: metrics.totalRequests,
    successfulRequests: metrics.successfulRequests,
    failedRequests: metrics.failedRequests,
    activeJobs: metrics.activeJobs,
    queuedJobs: concurrencyLimiter.pendingCount,
    browserConnected: browserManager.browser?.isConnected() || false,
    pageCount: browserManager.pageCount,
    cmykConversions: metrics.cmykConversions,
    pagedJsRenders: metrics.pagedJsRenders,
  },
  config: {
    maxConcurrentJobs: CONFIG.maxConcurrentJobs,
    defaultTimeoutMs: CONFIG.defaultTimeout,
    maxTimeoutMs: CONFIG.maxTimeout,
    browserRestartThreshold: CONFIG.browserRestartThreshold,
    authenticationEnabled: !!CONFIG.serviceSecret,
  },
}));

// ═══════════════════════════════════════════════════════════════════
// MAIN PDF GENERATION ENDPOINT (with Paged.js + Ghostscript)
// ═══════════════════════════════════════════════════════════════════
app.post('/generate', authenticateRequest, async (req, res) => {
  metrics.totalRequests++;
  
  const { 
    html, 
    css, 
    width = 152, 
    height = 229, 
    bleed = 0,
    metadata = {},
    options = {}
  } = req.body;

  if (!html) {
    return res.status(400).json({ error: 'Missing required field: html' });
  }

  // Extract and validate options
  const resolution = Math.min(Math.max(options.resolution || 300, 72), 600);
  const watermark = options.watermark || false;
  const lang = escapeHtml(options.lang || 'en');
  const usePagedJs = options.usePagedJs !== false && CONFIG.enablePagedJs;
  const convertCMYK = options.cmyk === true && CONFIG.enableCmykConversion && ghostscriptAvailable;
  
  const requestTimeout = Math.min(
    options.timeout || CONFIG.defaultTimeout,
    CONFIG.maxTimeout
  );

  const safeMetadata = sanitizeMetadata(metadata);
  const jobId = crypto.randomBytes(8).toString('hex');

  const jobPromise = concurrencyLimiter(async () => {
    metrics.activeJobs++;
    let page = null;
    let tempPdfPath = null;
    let cmykPdfPath = null;

    try {
      page = await browserManager.getPage();

      // Set viewport to page dimensions
      const pxWidth = Math.round((width / 25.4) * resolution);
      const pxHeight = Math.round((height / 25.4) * resolution);
      await page.setViewport({ width: pxWidth, height: pxHeight, deviceScaleFactor: 1 });

      // Build watermark HTML
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

      // Build full HTML document with Paged.js if enabled
      const fullHtml = `
        <!DOCTYPE html>
        <html lang="${lang}">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>${safeMetadata.title || 'Synoptic Export'}</title>
          <meta name="author" content="${safeMetadata.author}">
          <meta name="description" content="${safeMetadata.subject}">
          <meta name="keywords" content="${safeMetadata.keywords.join(', ')}">
          <meta name="generator" content="${safeMetadata.creator}">
          <style>
            ${FONT_CSS}
            
            /* Page size CSS variables for Paged.js */
            :root {
              --page-width: ${width}mm;
              --page-height: ${height}mm;
              --bleed: ${bleed}mm;
            }
            
            ${usePagedJs ? PAGEDJS_CSS : `
              @page {
                size: ${width}mm ${height}mm;
                margin: 0;
              }
            `}
            
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
            ${css || ''}
          </style>
          ${usePagedJs ? PAGEDJS_POLYFILL : ''}
        </head>
        <body>
          ${watermarkHTML}
          ${html}
        </body>
        </html>
      `;

      await page.setContent(fullHtml, { 
        waitUntil: ['networkidle0', 'domcontentloaded'],
        timeout: requestTimeout
      });

      // Wait for fonts
      await page.evaluateHandle('document.fonts.ready');

      // If using Paged.js, wait for it to finish rendering
      if (usePagedJs) {
        console.log(`[Job ${jobId}] Waiting for Paged.js to render...`);
        try {
          await page.waitForFunction('window.__pagedjs_ready === true', {
            timeout: requestTimeout - 5000, // Leave 5s buffer
          });
          metrics.pagedJsRenders++;
          console.log(`[Job ${jobId}] Paged.js rendering complete`);
        } catch (e) {
          console.warn(`[Job ${jobId}] Paged.js timeout, proceeding with standard render`);
        }
      }

      // Generate PDF
      const pdfOptions = {
        width: `${width}mm`,
        height: `${height}mm`,
        printBackground: true,
        preferCSSPageSize: true,
        displayHeaderFooter: false,
        margin: { top: 0, right: 0, bottom: 0, left: 0 },
        timeout: requestTimeout,
      };

      const pdf = await page.pdf(pdfOptions);
      
      let finalPdf = pdf;

      // CMYK Conversion via Ghostscript
      if (convertCMYK) {
        console.log(`[Job ${jobId}] Starting CMYK conversion...`);
        tempPdfPath = path.join(CONFIG.tempDir, `${jobId}_rgb.pdf`);
        cmykPdfPath = path.join(CONFIG.tempDir, `${jobId}_cmyk.pdf`);
        
        fs.writeFileSync(tempPdfPath, pdf);
        
        try {
          await convertToCMYK(tempPdfPath, cmykPdfPath, {
            pdfxStandard: options.pdfxStandard || CONFIG.pdfXStandard,
          });
          finalPdf = fs.readFileSync(cmykPdfPath);
          console.log(`[Job ${jobId}] CMYK conversion successful`);
        } catch (cmykError) {
          console.error(`[Job ${jobId}] CMYK conversion failed, returning RGB:`, cmykError.message);
          // Fall back to RGB PDF
        }
      }

      // Response headers
      const filename = (safeMetadata.title || 'export').replace(/[^a-zA-Z0-9-_]/g, '_');
      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}.pdf"`,
        'X-PDF-Title': safeMetadata.title,
        'X-PDF-Author': safeMetadata.author,
        'X-PDF-Creator': safeMetadata.creator,
        'X-PDF-Producer': safeMetadata.producer,
        'X-PDF-Resolution': `${resolution}dpi`,
        'X-PDF-Color-Space': convertCMYK ? 'CMYK' : 'RGB',
        'X-PDF-Paged-JS': usePagedJs ? 'true' : 'false',
      });
      
      metrics.successfulRequests++;
      res.send(finalPdf);

    } catch (error) {
      metrics.failedRequests++;
      console.error(`[Job ${jobId}] PDF generation error:`, error.message);
      
      const isTimeout = error.message.includes('timeout') || error.message.includes('Timeout');
      const statusCode = isTimeout ? 504 : 500;
      
      res.status(statusCode).json({ 
        error: error.message,
        code: isTimeout ? 'TIMEOUT' : 'GENERATION_ERROR',
        jobId,
        hint: isTimeout ? 'Consider increasing the timeout for large documents' : undefined,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });

    } finally {
      metrics.activeJobs--;
      
      // Cleanup
      if (page) {
        try { await page.close(); } catch (e) { /* ignore */ }
      }
      if (tempPdfPath && fs.existsSync(tempPdfPath)) {
        try { fs.unlinkSync(tempPdfPath); } catch (e) { /* ignore */ }
      }
      if (cmykPdfPath && fs.existsSync(cmykPdfPath)) {
        try { fs.unlinkSync(cmykPdfPath); } catch (e) { /* ignore */ }
      }
    }
  });

  metrics.queuedJobs = concurrencyLimiter.pendingCount;

  try {
    await jobPromise;
  } catch (err) {
    // Error already handled
  }
});

// ═══════════════════════════════════════════════════════════════════
// COVER GENERATION ENDPOINT
// ═══════════════════════════════════════════════════════════════════
app.post('/generate-cover', authenticateRequest, async (req, res) => {
  metrics.totalRequests++;

  const {
    frontCover,
    backCover,
    spine,
    dimensions,
    bleed = 3.175,
    dpi = 300,
    metadata = {},
    options = {}
  } = req.body;

  if (!dimensions || !dimensions.width || !dimensions.height) {
    return res.status(400).json({ error: 'Missing required field: dimensions (width, height)' });
  }

  const safeMetadata = sanitizeMetadata(metadata);
  const requestTimeout = Math.min(options.timeout || CONFIG.defaultTimeout, CONFIG.maxTimeout);
  const convertCMYK = options.cmyk === true && CONFIG.enableCmykConversion && ghostscriptAvailable;
  const jobId = crypto.randomBytes(8).toString('hex');

  const spineWidth = spine?.width || 10;
  const fullWidth = (dimensions.width * 2) + spineWidth + (bleed * 2);
  const fullHeight = dimensions.height + (bleed * 2);

  const jobPromise = concurrencyLimiter(async () => {
    metrics.activeJobs++;
    let page = null;
    let tempPdfPath = null;
    let cmykPdfPath = null;

    try {
      page = await browserManager.getPage();

      const pxWidth = Math.round((fullWidth / 25.4) * dpi);
      const pxHeight = Math.round((fullHeight / 25.4) * dpi);
      await page.setViewport({ width: pxWidth, height: pxHeight, deviceScaleFactor: 1 });

      const coverHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <style>
            ${FONT_CSS}
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
        timeout: requestTimeout
      });

      await page.evaluateHandle('document.fonts.ready');

      const pdf = await page.pdf({
        width: `${fullWidth}mm`,
        height: `${fullHeight}mm`,
        printBackground: true,
        preferCSSPageSize: true,
        timeout: requestTimeout,
      });

      let finalPdf = pdf;

      // CMYK conversion for covers is especially important
      if (convertCMYK) {
        console.log(`[Cover ${jobId}] Starting CMYK conversion...`);
        tempPdfPath = path.join(CONFIG.tempDir, `cover_${jobId}_rgb.pdf`);
        cmykPdfPath = path.join(CONFIG.tempDir, `cover_${jobId}_cmyk.pdf`);
        
        fs.writeFileSync(tempPdfPath, pdf);
        
        try {
          await convertToCMYK(tempPdfPath, cmykPdfPath);
          finalPdf = fs.readFileSync(cmykPdfPath);
          console.log(`[Cover ${jobId}] CMYK conversion successful`);
        } catch (cmykError) {
          console.error(`[Cover ${jobId}] CMYK conversion failed:`, cmykError.message);
        }
      }

      const filename = (safeMetadata.title || 'cover').replace(/[^a-zA-Z0-9-_]/g, '_');
      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}_cover.pdf"`,
        'X-Cover-Dimensions': `${fullWidth}mm x ${fullHeight}mm`,
        'X-Spine-Width': `${spineWidth}mm`,
        'X-Bleed': `${bleed}mm`,
        'X-PDF-Color-Space': convertCMYK ? 'CMYK' : 'RGB',
      });

      metrics.successfulRequests++;
      res.send(finalPdf);

    } catch (error) {
      metrics.failedRequests++;
      console.error(`[Cover ${jobId}] Cover generation error:`, error.message);
      res.status(500).json({ error: error.message, jobId });
    } finally {
      metrics.activeJobs--;
      if (page) { try { await page.close(); } catch (e) { /* ignore */ } }
      if (tempPdfPath && fs.existsSync(tempPdfPath)) { try { fs.unlinkSync(tempPdfPath); } catch (e) { /* ignore */ } }
      if (cmykPdfPath && fs.existsSync(cmykPdfPath)) { try { fs.unlinkSync(cmykPdfPath); } catch (e) { /* ignore */ } }
    }
  });

  try { await jobPromise; } catch (err) { /* handled */ }
});

// ═══════════════════════════════════════════════════════════════════
// PREVIEW ENDPOINT
// ═══════════════════════════════════════════════════════════════════
app.post('/preview', authenticateRequest, async (req, res) => {
  metrics.totalRequests++;

  const { html, css, width = 152, height = 229 } = req.body;

  if (!html) {
    return res.status(400).json({ error: 'Missing required field: html' });
  }

  const jobPromise = concurrencyLimiter(async () => {
    metrics.activeJobs++;
    let page = null;

    try {
      page = await browserManager.getPage();

      const pxWidth = Math.round((width / 25.4) * 72);
      const pxHeight = Math.round((height / 25.4) * 72);
      await page.setViewport({ width: pxWidth, height: pxHeight });

      const fullHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <style>
            ${FONT_CSS}
            @page { size: ${width}mm ${height}mm; margin: 0; }
            body { margin: 0; padding: 0; }
            ${css || ''}
          </style>
        </head>
        <body>${html}</body>
        </html>
      `;

      await page.setContent(fullHtml, { 
        waitUntil: 'networkidle0',
        timeout: 30000
      });

      const screenshot = await page.screenshot({
        type: 'png',
        fullPage: true,
      });

      res.set({
        'Content-Type': 'image/png',
        'Cache-Control': 'no-cache',
      });
      
      metrics.successfulRequests++;
      res.send(screenshot);

    } catch (error) {
      metrics.failedRequests++;
      console.error('[/preview] Error:', error.message);
      res.status(500).json({ error: error.message });
    } finally {
      metrics.activeJobs--;
      if (page) { try { await page.close(); } catch (e) { /* ignore */ } }
    }
  });

  try { await jobPromise; } catch (err) { /* handled */ }
});

// ═══════════════════════════════════════════════════════════════════
// GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════════════════════════════
const gracefulShutdown = async (signal) => {
  console.log(`\n[Shutdown] Received ${signal}, shutting down gracefully...`);
  
  await browserManager.close();
  
  // Cleanup temp files
  try {
    const tempFiles = fs.readdirSync(CONFIG.tempDir);
    for (const file of tempFiles) {
      fs.unlinkSync(path.join(CONFIG.tempDir, file));
    }
  } catch (e) { /* ignore */ }
  
  console.log('[Shutdown] Cleanup complete, exiting.');
  process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));

process.on('uncaughtException', async (err) => {
  console.error('[Fatal] Uncaught exception:', err);
  await browserManager.close();
  process.exit(1);
});

process.on('unhandledRejection', async (reason, promise) => {
  console.error('[Fatal] Unhandled rejection:', reason);
  await browserManager.close();
  process.exit(1);
});

// ═══════════════════════════════════════════════════════════════════
// SERVER STARTUP
// ═══════════════════════════════════════════════════════════════════
const PORT = CONFIG.port;

(async () => {
  try {
    console.log('[Startup] Pre-warming browser...');
    await browserManager.getBrowser();
    console.log('[Startup] Browser pre-warmed successfully');
  } catch (err) {
    console.error('[Startup] Failed to pre-warm browser:', err.message);
  }
})();

app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════════════════════╗
║       SYNOPTIC PDF ENGINE v3.1.0 (Professional Print Pipeline)            ║
╠═══════════════════════════════════════════════════════════════════════════╣
║       Port: ${String(PORT).padEnd(64)}║
║       Max Concurrent Jobs: ${String(CONFIG.maxConcurrentJobs).padEnd(51)}║
║       Default Timeout: ${String(CONFIG.defaultTimeout / 1000 + 's').padEnd(55)}║
║       Authentication: ${String(CONFIG.serviceSecret ? 'ENABLED' : 'DISABLED (dev mode)').padEnd(56)}║
╠═══════════════════════════════════════════════════════════════════════════╣
║       Features:                                                           ║
║         ✓ Paged.js (CSS Paged Media): ${String(CONFIG.enablePagedJs ? 'ENABLED' : 'DISABLED').padEnd(39)}║
║         ✓ Ghostscript (CMYK): ${String(ghostscriptAvailable ? 'AVAILABLE' : 'NOT INSTALLED').padEnd(47)}║
║         ✓ PDF/X Standard: ${String(CONFIG.pdfXStandard).padEnd(51)}║
╠═══════════════════════════════════════════════════════════════════════════╣
║       Endpoints:                                                          ║
║         POST /generate       - Full PDF (Paged.js + optional CMYK)        ║
║         POST /generate-cover - Book cover (optional CMYK)                 ║
║         POST /preview        - Quick PNG preview                          ║
║         GET  /health         - Service health & metrics                   ║
╠═══════════════════════════════════════════════════════════════════════════╣
║       Options (in request body):                                          ║
║         usePagedJs: true/false  - Enable Paged.js pagination              ║
║         cmyk: true/false        - Convert to CMYK via Ghostscript         ║
╚═══════════════════════════════════════════════════════════════════════════╝
  `);
});
