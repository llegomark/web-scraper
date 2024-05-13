# Web Scraper

This personal project implements a web scraper using JavaScript and Node.js. The scraper is designed to extract data from specified websites and save the data in CSV format. The project focuses on modularity, security, and maintainability to ensure robust and efficient scraping.

## Features

- **Scraping Data**: Extracts and processes data from specified URLs.
- **Pagination Handling**: Automatically navigates and scrapes data from multiple pages.
- **Configuration**: Easily configurable through a `config.js` file.
- **CSV Export**: Saves extracted data in CSV format.
- **Progress Save/Resume**: Saves progress to a file and resumes from the last scraped page.
- **Robust Error Handling**: Handles errors and retries failed requests using `axios` and `axios-retry`.
- **Logging**: Detailed logging using `winston`.
- **Queue Management**: Manages concurrent requests using `p-queue`.

## Technical Details

- **Libraries Used**:
  - `htmlparser2`: For parsing HTML content and extracting data.
  - `axios`: For making HTTP requests.
  - `axios-retry`: For retry logic on failed requests.
  - `csv-stringify`: For generating CSV files.
  - `winston`: For logging.
  - `p-queue`: For managing concurrent requests.
  - `sanitize-html`: For sanitizing extracted HTML content.

## Getting Started

### Prerequisites

- Node.js (version >= 20)
- npm or yarn

### Installation

1. Clone the repository:
   ```sh
   git clone https://github.com/llegomark/web-scraper.git
   cd web-scraper
   ```

2. Install dependencies:
   ```sh
   npm install
   ```
   or
   ```sh
   yarn install
   ```

3. Configure the scraper by editing the `config.js` file:
   ```javascript
   export default {
       urls: {
           url1: 'https://example.com/page1',
           url2: 'https://example.com/page2'
       },
       concurrency: 5,
       csvHeaders: ['header1', 'header2', 'header3'],
       viewUrlPath: '/view/',
       downloadUrlPath: '/download/',
       baseUrl: 'https://example.com'
   };
   ```

### Running the Scraper

Execute the following command to start the scraper:
```sh
node app.mjs
```

### Logging

Logs are available in the `scraper.log` file in the root directory. Logging can be adjusted by modifying the logger configuration in `app.mjs`.

### Pausing and Resuming

You can pause and resume scraping by calling the respective methods on the scraper instances. This is handled automatically in the provided `main` function.

## Contributing

This project is for personal use only and is not open for contributions or pull requests at this time.

## License

This project is licensed under the [MIT License](LICENSE).