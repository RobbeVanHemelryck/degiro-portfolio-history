# DEGIRO Portfolio History

DEGIRO Portfolio History imports DEGIRO account exports and stores transaction and market history in a local SQLite database. It provides a web interface to review holdings, price history, and portfolio performance over time.

## Installation

### Option 1: Docker Compose

```yaml
degiro-portfolio-history:
  image: taltiko/degiro-portfolio-history:latest
  ports:
    - 8000:8000
  volumes:
    - <database-folder>:/config
```

Replace `<database-folder>` with a local folder path where you want the database to be persisted.

### Option 2: Run locally

1. Prerequisites: Node.js 20+ (download from [nodejs.org](https://nodejs.org))
2. Clone or download this repository
3. Install dependencies:
   ```bash
   npm install
   ```
4. Start the server:
   ```bash
   npm start
   ```
5. Open your browser to `http://localhost:8000`

The database will be created in `/config` directory (or set the `DEGIRO_PORTFOLIO_DB_DIR` environment variable to specify a different location).

## Import Data

The app expects two Excel files from DEGIRO:

1. Account statement extract: contains deposits, withdrawals, and other cash movements.
2. Transactions extract: contains buy and sell transactions.

### 1) Export account statement extract from DEGIRO

1. Sign in to DEGIRO, go to Reports → Account statement.
2. Select your desired date range.
3. Export as Excel (.xlsx)
4. Upload via gear icon => "Upload account statement".

### 2) Export transactions extract from DEGIRO

1. Sign in to DEGIRO, go to Reports → Transactions.
2. Select your desired date range.
3. Export as Excel (.xlsx)
4. Upload via gear icon => "Upload transactions".

Tip: when importing for the first time, upload both files using the same full date range so transaction history and cash movements are aligned.

## Preview

### Desktop preview
![Desktop preview](docs/desktop.gif)

### Mobile preview
<img src="docs/mobile.gif" alt="Mobile preview" width="280" />

See [docs](docs/) for additional screenshots.
