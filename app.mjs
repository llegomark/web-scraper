import process from 'process';
import { Parser as HtmlParser } from 'htmlparser2';
import axios from 'axios';
import axiosRetry from 'axios-retry';
import https from 'https';
import { stringify } from 'csv-stringify';
import { createWriteStream, existsSync, readFileSync, writeFileSync } from 'fs';
import winston from 'winston';
import async from 'async';
import config from './config.js';

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ level, message, timestamp }) => {
            return `${timestamp} ${level}: ${message}`;
        })
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'scraper.log' })
    ]
});

class WebScraper {
    constructor(url, outputFile) {
        this.url = url;
        this.outputFile = outputFile;
        this.csvStream = null;
        this.csvStringifier = null;
        this.httpsAgent = new https.Agent({ rejectUnauthorized: false });
        this.headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        };
        this.progressFile = `${outputFile}.progress`;
        this.lastScrapedPage = 1;
    }

    async scrape() {
        try {
            logger.info(`Starting scraping for URL: ${this.url}`);
            this.initializeCsvStream();
            this.loadProgress();
            await this.scrapePages();
            await this.closeCsvStream();
            logger.info(`Finished scraping for URL: ${this.url}`);
        } catch (error) {
            logger.error(`Error during scraping: ${error.message}`);
            throw error;
        }
    }

    initializeCsvStream() {
        logger.info(`Initializing CSV stream for file: ${this.outputFile}`);
        this.csvStream = createWriteStream(this.outputFile, { flags: 'a' });
        this.csvStringifier = stringify({ header: !existsSync(this.outputFile), columns: config.csvHeaders });
        this.csvStringifier.pipe(this.csvStream);
    }

    async getTotalPages() {
        try {
            logger.info(`Retrieving total pages for URL: ${this.url}`);
            const response = await axios.get(this.url, { httpsAgent: this.httpsAgent, headers: this.headers });
            const html = response.data;
            this.totalPages = 1;
            const parser = new HtmlParser({
                onopentag: (name, attributes) => {
                    if (name === 'a' && attributes.href && attributes.href.includes('page=')) {
                        const pageNumber = parseInt(attributes.href.match(/page=(\d+)/)?.[1]);
                        if (pageNumber && pageNumber > this.totalPages) {
                            this.totalPages = pageNumber;
                        }
                    }
                },
            });
            parser.write(html);
            parser.end();
            logger.info(`Total pages: ${this.totalPages}`);
        } catch (error) {
            logger.error(`Error retrieving total pages: ${error.message}`);
            throw error;
        }
    }

    async scrapePages() {
        try {
            await this.getTotalPages();
            const pageUrls = Array.from({ length: this.totalPages }, (_, i) => `${this.url}?page=${i + 1}`);

            await async.eachLimit(pageUrls.slice(this.lastScrapedPage - 1), config.concurrency, async (pageUrl) => {
                try {
                    logger.info(`Scraping page ${pageUrl}`);
                    const response = await axios.get(pageUrl, { httpsAgent: this.httpsAgent, headers: this.headers });

                    if (response.status === 200) {
                        const html = response.data;
                        await this.parsePage(html);
                        this.lastScrapedPage++;
                        this.saveProgress();
                    } else {
                        logger.warn(`Unexpected response status ${response.status} for page ${pageUrl}`);
                    }
                } catch (error) {
                    logger.error(`Error scraping page ${pageUrl}: ${error.message}`);
                    throw error;
                }
            });
        } catch (error) {
            logger.error(`Error scraping pages: ${error.message}`);
            throw error;
        }
    }

    async parsePage(html) {
        return new Promise((resolve, reject) => {
            const parserConfig = {
                onopentag: (name, attributes) => {
                    if (name === 'tr' && (!attributes.class || !attributes.class.includes('table-striped'))) {
                        this.currentRow = {};
                    }
                    if (name === 'td') {
                        this.currentCell = '';
                    }
                    if (name === 'a' && attributes.href) {
                        if (attributes.href.startsWith(config.viewUrlPath)) {
                            this.currentRow[config.viewUrlHeader] = `${config.baseUrl}${attributes.href}`;
                        } else if (attributes.href.startsWith(config.downloadUrlPath)) {
                            this.currentRow[config.downloadUrlHeader] = `${config.baseUrl}${attributes.href}`;
                        }
                    }
                },
                ontext: (text) => {
                    if (this.currentCell !== undefined) {
                        this.currentCell += text.trim();
                    }
                },
                onclosetag: (name) => {
                    if (name === 'td') {
                        const currentCellName = config.csvHeaders.find(cellName => !(cellName in this.currentRow));
                        if (currentCellName) {
                            this.currentRow[currentCellName] = this.currentCell;
                        }
                        this.currentCell = undefined;
                    }
                    if (name === 'tr' && Object.keys(this.currentRow).length > 0) {
                        logger.info(`Scraped data: ${JSON.stringify(this.currentRow)}`);
                        this.csvStringifier.write(this.currentRow);
                        this.currentRow = {};
                    }
                },
                onerror: (error) => {
                    reject(error);
                },
                onend: () => {
                    resolve();
                },
            };

            const parser = new HtmlParser(parserConfig);
            parser.write(html);
            parser.end();
        });
    }

    async closeCsvStream() {
        logger.info(`Closing CSV stream for file: ${this.outputFile}`);
        return new Promise((resolve) => {
            this.csvStringifier.end(resolve);
        });
    }

    loadProgress() {
        if (existsSync(this.progressFile)) {
            const progress = JSON.parse(readFileSync(this.progressFile));
            this.lastScrapedPage = progress.lastScrapedPage;
            logger.info(`Resuming scraping from page ${this.lastScrapedPage}`);
        }
    }

    saveProgress() {
        const progress = {
            lastScrapedPage: this.lastScrapedPage,
        };
        writeFileSync(this.progressFile, JSON.stringify(progress));
    }
}

function configureAxiosRetry(axios) {
    axiosRetry(axios, {
        retries: 3,
        retryDelay: (retryCount, error) => {
            if (error.response?.status === 429) {
                return retryCount * 2000;
            }
            return retryCount * 1000;
        },
        retryCondition: (error) => {
            return (
                error.response?.status === 429 ||
                error.code === 'ECONNABORTED' ||
                [500, 502, 503, 504].includes(error.response?.status)
            );
        },
    });
}

async function main() {
    try {
        configureAxiosRetry(axios);

        const scraper1 = new WebScraper(config.urls.url1, 'output1.csv');
        await scraper1.scrape();

        const scraper2 = new WebScraper(config.urls.url2, 'output2.csv');
        await scraper2.scrape();
    } catch (error) {
        logger.error(`Unhandled error: ${error.message}`);
        process.exit(1);
    }
}

main();