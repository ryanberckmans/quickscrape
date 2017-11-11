#!/usr/bin/env node

// to facilitate parallelization in shell scripting, set stdout blocking
// to true so that writes to stdout are immediately available downstream.
process.stdout._handle.setBlocking(true);

var program = require('commander')
  , fs = require('fs')
  , winston = require('winston')
  , which = require('which').sync
  , path = require('path')
  , thresher = require('thresher')
  , Thresher = thresher.Thresher
  , ScraperBox = thresher.ScraperBox
  , Scraper = thresher.Scraper
  , ep = require('../lib/eventparse.js')
  , outformat = require('../lib/outformat.js')
  , sanitize = require('sanitize-filename');


var pjson = require('../package.json');
QSVERSION =  pjson.version;

program
  .version(pjson.version)
  .option('-u, --url <url>',
          'URL to scrape')
  .option('-r, --urllist <path>',
          'path to file with list of URLs to scrape (one per line)')
  .option('-s, --scraper <path>',
          'path to scraper definition (in JSON format)')
  .option('-d, --scraperdir <path>',
          'path to directory containing scraper definitions (in JSON format)')
  .option('-o, --output <path>',
          'where to output results ' +
          '(directory will be created if it doesn\'t exist',
          'output')
  .option('-t, --stdoutresults',
          'also write results.json to stdout (output directory unmodified)')
  .option('-n, --numberdirs',
          'use a number instead of the URL to name output subdirectories')
  .option('-i, --ratelimit <int>',
          'maximum number of scrapes per minute (default 3)', 3)
  .option('-h, --headless',
          'render all pages in a headless browser')
  .option('-l, --loglevel <level>',
          'amount of information to log ' +
          '(silent, verbose, info*, data, warn, error, or debug)',
          'info')
  .option('-f, --outformat <name>',
          'JSON format to transform results into (currently only bibjson)')
  .parse(process.argv);

if (!process.argv.slice(2).length) {
  program.help();
}

const allLogLevels = ['debug', 'info', 'warn', 'error']; // all the log levels we expect to be sent to winston's log
if (allLogLevels.indexOf(program.loglevel) == -1) {
  winston.error('Loglevel must be one of: debug, info, warn error');
  process.exit(1);
}

log = new (winston.Logger)({
  transports: [new (winston.transports.Console)({
    stderrLevels: allLogLevels, // never log to stdout, we wish to reserve stdout for scraping results
    timestamp: true,
  })],
  level: program.loglevel,
  colorize: true,
});
log.info('logging to stderr');

if (!(program.url || program.urllist) || (program.url && program.urllist)) {
  log.error('You must provide a URL xor list of URLs to scrape');
  process.exit(1);
}

urllist = program.url ? [program.url] : loadUrls(program.urllist);
log.info('urls to scrape:', urllist.length);

// have to do this before changing directory
if (program.scraper) program.scraper = path.resolve(program.scraper)
if (program.scraperdir) program.scraperdir = path.resolve(program.scraperdir)

// create output directory
if (!fs.existsSync(program.output)) {
    log.debug('creating output directory: ' + program.output);
    fs.mkdirSync(program.output);
}
process.chdir(program.output);
tld = process.cwd();

// verify arguments
if (program.scraper && program.scraperdir) {
  log.error('Please use either --scraper or --scraperdir, not both');
  process.exit(1);
}

if (!(program.scraper || program.scraperdir)) {
  log.error('You must provide a scraper definition');
  process.exit(1);
}

if (program.outformat) {
  if (!program.outformat.toLowerCase() == 'bibjson') {
    log.error('Outformat ' + program.outformat + ' is not valid.');
  }
}

// log options
log.info('quickscrape ' + QSVERSION + ' launched with...');
if (program.url) {
  log.info('- URL: ' + program.url);
} else {
  log.info('- URLs from file: ' + program.urllist);
}
if (program.scraper) {
  log.info('- Scraper:', program.scraper);
}
if (program.scraperdir) {
  log.info('- Scraperdir:', program.scraperdir);
}
log.info('- Rate limit:', program.ratelimit, 'per minute');
log.info('- Log level:', program.loglevel);

// check scrapers
if (program.scraperdir) {
  var scrapers = new ScraperBox(program.scraperdir);
  if (scrapers.scrapers.length == 0) {
    log.error('the scraper directory provided did not contain any ' +
              'valid scrapers');
    exit(1);
  }
}
if (program.scraper) {
  var definition = fs.readFileSync(program.scraper);
  var scraper = new Scraper(JSON.parse(definition));
  if (!scraper.valid) {
    scraper.on('definitionError', function(problems) {
      log.error('the scraper provided was not valid for the following reason(s):');
      problems.forEach(function(p) {
        log.error('\t- ' + p);
      });
      exit(1);
    });
    scraper.validate(definition);
  }
}

// load list of URLs from a file
function loadUrls(path) {
  var list = fs.readFileSync(path, {
    encoding: 'utf8'
  });
  return list.split('\n').map(function(cv) {
    return cv.trim();
  }).filter(function(x) {
    return x.length > 0;
  });
}

// this is the callback we pass to the scraper, so the program
// can exit when all asynchronous file and download tasks have finished
var finish = function() {
  // delay exit to allow final URL to complete processing and I/O
  setTimeout(() => {
    log.info('all tasks completed');
    process.exit(0);
  }, 3000);
}

// set up crude rate-limiting
mintime = 60000 / program.ratelimit;
lasttime = new Date().getTime();

done = false;
next = 0;

var checkForNext = function() {
  var now = new Date().getTime();
  var diff = now - lasttime;
  var timeleft = Math.max(mintime - diff, 0);
  if (timeleft == 0 && done) {
    next ++;
    if (next < urllist.length) {
      lasttime = new Date().getTime();
      processUrl(urllist[next]);
      if (next == urllist.length - 1) {
        finish();
      }
    } else {
      finish();
    }
  } else if (done) {
    if (next == urllist.length - 1) {
      finish();
    }
  }
}

// process a URL
let globalCurrentUrl; // Hack to easily re-use current URL in another function
var i = 0;
var processUrl = function(url) {
  globalCurrentUrl = url;
  i += 1;
  done = false;
  log.info('processing URL:', url);

  // load the scraper definition(s)
  var scrapers = new ScraperBox(program.scraperdir);
  if (program.scraper) {
    scrapers.addScraper(program.scraper);
  }
  if (scrapers.scrapers.length == 0) {
    log.warn('no scrapers ')
    return;
  }

  // url-specific output dir
  var dir = program.numberdirs ? ('' + i) : url.replace(/\/+/g, '_').replace(/:/g, '');
  dir = sanitize(path.join(tld, dir));
  if (!fs.existsSync(dir)) {
    log.debug('creating output directory: ' + dir);
    fs.mkdirSync(dir);
  }
  process.chdir(dir);

  // run scraper
  var capturesFailed = 0;
  var t = new Thresher(scrapers);

  t.on('scraper.*', function(var1, var2) {
    log.log(ep.getlevel(this.event),
            ep.compose(this.event, var1, var2));
  });

  t.on('scraper.elementCaptureFailed', function() {
    capturesFailed += 1;
  })

  t.on('scraper.renderer.*', function(var1, var2) {
    log.info(this.event, var1, var2)
  });

  t.once('result', function(result, structured) {
    const url = globalCurrentUrl;

    var nresults = Object.keys(result).length
    log.info('URL processed: captured ' + (nresults - capturesFailed) + '/' +
             nresults + ' elements (' + capturesFailed + ' captures failed)');

    // Add url to results so it's easily available downstream
    if (result.hasOwnProperty('url')) {
      console.error("expected unstructured result to not have prop 'url' for url", url);
    } else {
      result.url = url;
    }
    if (structured.hasOwnProperty('url')) {
      console.error("expected structured result to not have prop 'url' for url", url);
    } else {
      structured.url = { value: url };
    }

    outfile = 'results.json'
    outputString = JSON.stringify(structured);
    log.debug('unstructured result:', JSON.stringify(result));
    log.debug('structured result:', outputString);
    log.debug('writing results to file:', outfile);
    fs.writeFileSync(outfile, outputString);
    if (program.stdoutresults) {
      log.debug('also writing results to stdout');
      process.stdout.write(outputString);
      process.stdout.write('\n'); // newline so that there's one results.json per line, facilitating xargs
    }
    // write out any extra formats
    if (program.outformat) {
      outformat.format(program.outformat, structured);
    }
    log.debug('changing back to top-level directory');
    process.chdir(tld);

    // if we don't remove all the listeners, processing more URLs
    // will post messages  to all the listeners from previous URLs
    t.removeAllListeners();
    t = null;

    done = true;
  });

  t.scrape(url, program.headless);
}

setInterval(checkForNext, 100);
processUrl(urllist[0]);
