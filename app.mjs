import process from 'process';
import { Parser as HtmlParser } from 'htmlparser2';
import axios from 'axios';
import axiosRetry from 'axios-retry';
import https from 'https';
import { stringify } from 'csv-stringify';
import { createWriteStream, existsSync, readFileSync, writeFileSync, renameSync } from 'fs';
import winston from 'winston';
import PQueue from 'p-queue';
import config from './config.js';
import sanitizeHtml from 'sanitize-html';

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

const httpsAgent = new https.Agent({
    ca: readFileSync('./cacert-2024-03-11.pem')
});

class CsvHandler {
    constructor(outputFile, csvHeaders) {
        this.outputFile = outputFile;
        this.csvHeaders = csvHeaders;
        this.csvStream = null;
        this.csvStringifier = null;
        this.initializeCsvStream();
    }

    initializeCsvStream() {
        logger.info(`Initializing CSV stream for file: ${this.outputFile}`);
        this.csvStream = createWriteStream(this.outputFile, { flags: 'a' });
        this.csvStringifier = stringify({ header: !existsSync(this.outputFile), columns: this.csvHeaders });
        this.csvStringifier.pipe(this.csvStream);
    }

    writeRow(row) {
        this.csvStringifier.write(row);
    }

    closeCsvStream() {
        logger.info(`Closing CSV stream for file: ${this.outputFile}`);
        return new Promise((resolve) => {
            this.csvStringifier.end(resolve);
        });
    }
}

class ProgressHandler {
    constructor(progressFile) {
        this.progressFile = progressFile;
    }

    loadProgress() {
        if (existsSync(this.progressFile)) {
            const progress = JSON.parse(readFileSync(this.progressFile));
            logger.info(`Resuming scraping from page ${progress.lastScrapedPage}`);
            return progress.lastScrapedPage;
        }
        return 1;
    }

    saveProgress(page) {
        const progress = { lastScrapedPage: page };
        safeWriteFileSync(this.progressFile, JSON.stringify(progress));
    }
}

const safeWriteFileSync = (filePath, data) => {
    const tempFile = `${filePath}.tmp`;
    writeFileSync(tempFile, data);
    renameSync(tempFile, filePath);
};

class BaseScraper {
    constructor(url, progressHandler, csvHandler, queue) {
        this.url = url;
        this.progressHandler = progressHandler;
        this.csvHandler = csvHandler;
        this.queue = queue;
        this.headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        };
        this.isPaused = false;
        this.lastScrapedPage = 1;
        this.totalPages = 1;
    }

    async scrape() {
        try {
            logger.info(`Starting scraping for URL: ${this.url}`);
            this.lastScrapedPage = this.progressHandler.loadProgress();
            await this.scrapePages();
            await this.csvHandler.closeCsvStream();
            logger.info(`Finished scraping for URL: ${this.url}`);
        } catch (error) {
            logger.error(`Error during scraping: ${error.message}`);
            throw error;
        }
    }

    async getTotalPages() {
        try {
            logger.info(`Retrieving total pages for URL: ${this.url}`);
            const response = await axios.get(this.url, { httpsAgent, headers: this.headers });
            const html = response.data;
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

            this.queue.on('active', () => { logger.info(`Task active. Size: ${this.queue.size} | Pending: ${this.queue.pending}`); });
            this.queue.on('completed', () => { logger.info(`Task completed. Size: ${this.queue.size} | Pending: ${this.queue.pending}`); });
            this.queue.on('error', (error) => { logger.error(`Task error: ${error.message}`); });
            this.queue.on('empty', () => { logger.info('Queue is empty'); });
            this.queue.on('idle', () => { logger.info('Queue is idle'); });
            this.queue.on('add', () => { logger.info(`Task added. Size: ${this.queue.size} | Pending: ${this.queue.pending}`); });
            this.queue.on('next', () => { logger.info(`Task completed. Size: ${this.queue.size} | Pending: ${this.queue.pending}`); });

            for (const pageUrl of pageUrls.slice(this.lastScrapedPage - 1)) {
                this.queue.add(async () => {
                    if (await this.scrapePage(pageUrl)) {
                        this.progressHandler.saveProgress(this.lastScrapedPage++);
                    }
                });
            }

            await this.queue.onIdle();
        } catch (error) {
            logger.error(`Error scraping pages: ${error.message}`);
            throw error;
        }
    }

    async scrapePage(pageUrl) {
        try {
            logger.info(`Scraping page ${pageUrl}`);
            const response = await axios.get(pageUrl, { httpsAgent, headers: this.headers });
            if (response.status === 200) {
                const html = response.data;
                await this.parsePage(html);
                return true;
            } else {
                logger.warn(`Unexpected response status ${response.status} for page ${pageUrl}`);
                return false;
            }
        } catch (error) {
            logger.error(`Error scraping page ${pageUrl}: ${error.message}`);
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
                    if (typeof this.currentCell !== 'undefined') {
                        this.currentCell += sanitizeHtml(text.trim());
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
                        this.csvHandler.writeRow(this.currentRow);
                        this.currentRow = {};
                    }
                },
                onerror: (error) => {
                    reject(error);
                },
                onend: () => {
                    resolve();
                }
            };

            const parser = new HtmlParser(parserConfig);
            parser.write(html);
            parser.end();
        });
    }

    pause() {
        if (!this.isPaused) {
            this.queue.pause();
            this.isPaused = true;
            logger.info('Scraping paused');
        }
    }

    resume() {
        if (this.isPaused) {
            this.queue.start();
            this.isPaused = false;
            logger.info('Scraping resumed');
        }
    }
}

class WebScraper extends BaseScraper {
    constructor(url, outputFile) {
        const csvHandler = new CsvHandler(outputFile, config.csvHeaders);
        const progressHandler = new ProgressHandler(`${outputFile}.progress`);
        const queue = new PQueue({ concurrency: config.concurrency });
        super(url, progressHandler, csvHandler, queue);
    }
}

function configureAxiosRetryInstance(instance) {
    axiosRetry(instance, {
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
        }
    });
}

async function main() {
    try {
        configureAxiosRetryInstance(axios);

        const scraper1 = new WebScraper(config.urls.url1, 'output1.csv');
        await scraper1.scrape();

        scraper1.pause();

        const scraper2 = new WebScraper(config.urls.url2, 'output2.csv');
        await scraper2.scrape();

        setTimeout(() => {
            scraper1.resume();
        }, 5000);
    } catch (error) {
        logger.error(`Unhandled error: ${error.message}`);
        process.exit(1);
    }
}

main();