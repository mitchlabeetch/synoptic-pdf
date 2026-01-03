# Synoptic PDF Engine v3.1.0

A professional PDF generation microservice for Synoptic Studio, featuring **Paged.js** for CSS Paged Media support and **Ghostscript** for print-ready CMYK conversion.

## 🏗️ Architecture: Professional Print Pipeline

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     SYNOPTIC PDF ENGINE v3.1.0                              │
│                                                                             │
│  ┌──────────┐   ┌─────────────┐   ┌──────────────┐   ┌─────────────────┐   │
│  │  Client  │──▶│   Express   │──▶│  Concurrency │──▶│ BrowserManager  │   │
│  │   HTML   │   │   Server    │   │    Limiter   │   │   (Singleton)   │   │
│  └──────────┘   └─────────────┘   └──────────────┘   └─────────────────┘   │
│                                                               │             │
│                                                               ▼             │
│                                                     ┌─────────────────┐     │
│                                                     │    Puppeteer    │     │
│                                                     │  + Paged.js     │     │
│                                                     └─────────────────┘     │
│                                                               │             │
│                                           ┌───────────────────┼───────────┐ │
│                                           │ Premium Only      ▼           │ │
│                                           │         ┌─────────────────┐   │ │
│                                           │         │   Ghostscript   │   │ │
│                                           │         │  RGB → CMYK     │   │ │
│                                           │         │   PDF/X-1a      │   │ │
│                                           │         └─────────────────┘   │ │
│                                           └───────────────────────────────┘ │
│                                                               │             │
│                                                               ▼             │
│                                                     ┌─────────────────┐     │
│                                                     │   Final PDF     │     │
│                                                     └─────────────────┘     │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 🌟 Key Features

### Core (All Users)

- **Singleton Browser Pattern** - Reuses Chromium instance across requests
- **Concurrency Control** - Prevents resource exhaustion under load
- **API Authentication** - Protects against unauthorized access
- **300 DPI Output** - Print-quality resolution

### Premium Features

- **Paged.js Integration** - CSS Paged Media polyfill:
  - Mirror margins (recto/verso pages)
  - Running headers (title on right, author on left)
  - Cross-references and page counters
  - Proper orphan/widow control
  - Chapter breaks (always start on right page)
- **Font Parity** - Geist, Outfit, Quicksand, Spectral, Crimson Pro

### Publisher Tier

- **Ghostscript CMYK Conversion** - True print-ready output:
  - RGB to CMYK color conversion
  - PDF/X-1a compliance
  - 300 DPI minimum resolution
  - Font embedding and subsetting
  - Compatible with KDP, IngramSpark, offset printers

## 📋 Configuration

### Environment Variables

| Variable                    | Default  | Description                   |
| --------------------------- | -------- | ----------------------------- |
| `PORT`                      | 3000     | Server port                   |
| `PDF_SERVICE_SECRET`        | (none)   | API key for authentication    |
| `MAX_CONCURRENT_JOBS`       | 3        | Max parallel PDF jobs         |
| `DEFAULT_TIMEOUT_MS`        | 120000   | Default timeout (2 min)       |
| `MAX_TIMEOUT_MS`            | 600000   | Max timeout (10 min)          |
| `BROWSER_RESTART_THRESHOLD` | 100      | Restart browser after N pages |
| `ENABLE_PAGEDJS`            | true     | Enable Paged.js polyfill      |
| `ENABLE_CMYK_CONVERSION`    | true     | Enable Ghostscript CMYK       |
| `PDF_X_STANDARD`            | PDF/X-1a | PDF/X compliance level        |

## 📡 API Endpoints

### `POST /generate`

Generate a PDF with optional Paged.js and CMYK conversion.

**Headers:**

```
Content-Type: application/json
X-Service-Key: <your-secret>
```

**Request Body:**

```json
{
  "html": "<body>...</body>",
  "css": "...",
  "width": 152,
  "height": 229,
  "bleed": 3.175,
  "metadata": {
    "title": "My Bilingual Book",
    "author": "Author Name"
  },
  "options": {
    "resolution": 300,
    "usePagedJs": true,
    "cmyk": true,
    "pdfxStandard": "PDF/X-1a"
  }
}
```

**Response Headers:**

```
X-PDF-Color-Space: CMYK
X-PDF-Paged-JS: true
X-PDF-Resolution: 300dpi
```

### `GET /health`

Check service health and capabilities.

**Response:**

```json
{
  "status": "ok",
  "version": "3.1.0",
  "features": {
    "pagedJs": true,
    "cmykConversion": true,
    "ghostscriptAvailable": true,
    "pdfXStandard": "PDF/X-1a"
  },
  "metrics": {
    "totalRequests": 150,
    "cmykConversions": 45,
    "pagedJsRenders": 105
  }
}
```

## 🎨 Paged.js CSS Features

When `usePagedJs: true`, you get access to CSS Paged Media properties:

```css
/* Mirror margins (automatic with Paged.js) */
@page: left{
  margin-right: 25mm; /* Gutter on left pages */
};

@page: right{
  margin-left: 25mm; /* Gutter on right pages */
};

/* Running headers */
@page: right{
  @top-right {
    content: string(title);
  }
};

h1.book-title {
  string-set: title content(text);
}

/* Chapter starts on right page */
.chapter-start {
  break-before: right;
}

/* Prevent orphans/widows */
p {
  orphans: 2;
  widows: 2;
}
```

## 🖨️ CMYK Conversion Details

When `cmyk: true`, Ghostscript performs:

1. **Color Space Conversion** - RGB → CMYK using professional algorithms
2. **Font Embedding** - All fonts embedded and subsetted
3. **Image Optimization** - Downsampled to 300 DPI
4. **PDF/X Compliance** - Meets print industry standards
5. **Transparency Flattening** - Safe for offset printing

**Ghostscript Command (for reference):**

```bash
gs -dNOPAUSE -dBATCH -sDEVICE=pdfwrite \
   -dPDFSETTINGS=/prepress \
   -dColorConversionStrategy=CMYK \
   -dProcessColorModel=/DeviceCMYK \
   -dCompatibilityLevel=1.4 \
   -dEmbedAllFonts=true \
   -sOutputFile=output.pdf input.pdf
```

## 🐳 Docker Deployment

### Build

```bash
docker build -t synoptic-pdf:3.1.0 .
```

### Run

```bash
docker run -d \
  --name synoptic-pdf \
  -p 3000:3000 \
  -e PDF_SERVICE_SECRET=your-secret \
  -e ENABLE_CMYK_CONVERSION=true \
  synoptic-pdf:3.1.0
```

### Verify Ghostscript

```bash
docker exec synoptic-pdf gs --version
# Expected: 10.x.x
```

## 📊 Tier Feature Matrix

| Feature         | Free    | Pro     | Publisher |
| --------------- | ------- | ------- | --------- |
| PDF Export      | ✅      | ✅      | ✅        |
| Resolution      | 150 DPI | 300 DPI | 300 DPI   |
| Watermark       | Yes     | No      | No        |
| Paged.js        | ❌      | ✅      | ✅        |
| CMYK Conversion | ❌      | ❌      | ✅        |
| PDF/X-1a        | ❌      | ❌      | ✅        |

## 🔧 Development

### Prerequisites

- Node.js 18+
- Ghostscript (for CMYK testing)

### Local Setup

```bash
# Install dependencies
npm install

# Start in dev mode
npm run dev

# Test health
curl http://localhost:3000/health
```

### Testing CMYK Conversion

```bash
# Generate with CMYK
curl -X POST http://localhost:3000/generate \
  -H "Content-Type: application/json" \
  -d '{"html": "<h1>Test</h1>", "css": "", "options": {"cmyk": true}}' \
  --output test_cmyk.pdf

# Verify color space with pdfinfo
pdfinfo test_cmyk.pdf | grep "Color"
```

## 📝 Changelog

### v3.1.0 (Professional Print Pipeline)

- ✅ Paged.js integration for CSS Paged Media
- ✅ Ghostscript CMYK/PDF-X conversion
- ✅ Mirror margins and running headers
- ✅ Orphan/widow control
- ✅ Chapter break handling
- ✅ ICC color profile support (FOGRA39)
- ✅ Crimson Pro font added

### v3.0.0

- Singleton browser pattern
- Concurrency control with p-limit
- API key authentication
- Graceful shutdown handling

### v2.0.0

- Initial production implementation

## 🐛 Troubleshooting

### "Ghostscript: command not found"

Install Ghostscript in your container or host system.

### CMYK colors look different

RGB to CMYK conversion can shift colors slightly. For critical color work, provide CMYK values directly or use ICC profiles.

### Paged.js timeout

Large documents may exceed the Paged.js render timeout. Increase `timeout` in options.

### Fonts not embedding

Ensure fonts are installed in `/usr/share/fonts/truetype/synoptic/` and `fc-cache -f -v` was run.
