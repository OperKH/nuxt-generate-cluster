#!/usr/bin/env node

const cluster = require('cluster')

if (cluster.isMaster) {
  const meow = require('meow')

  const cli = meow(`
      Description
        Generate a static web application (server-rendered)
      Usage
        $ nuxt-generate <dir>
      Options
        -b, --build           Whether to (re-)build the nuxt project
        -c, --config-file     Path to Nuxt.js config file (default: nuxt.config.js)
        -h, --help            Displays this message
        -p, --params          Extra parameters which should be passed to routes method
                                (should be a JSON string or queryString)
        -q, --quiet           Decrease verbosity (repeat to decrease more)
        -v, --verbose         Increase verbosity (repeat to increase more)
        --fail-on-page-error  Immediately exit when a page throws an unhandled error
        -w, --workers [NUM]   How many workers should be started
                                (default: # cpus)
        -wc [NUM],            How many routes should be sent to 
        --worker-concurrency [NUM]    a worker per iteration

  `, {
    flags: {
      build: {
        type: 'boolean',
        default: false,
        alias: 'b'
      },
      config: {
        type: 'string',
        default: 'nuxt.config.js',
        alias: 'c'
      },
      help: {
        type: 'boolean',
        default: false,
        alias: 'h'
      },
      params: {
        type: 'string',
        default: '',
        alias: 'p'
      },
      quiet: {
        type: 'boolean',
        default: false
      },
      verbose: {
        type: 'boolean',
        default: false
      },
      workers: {
        type: 'number',
        default: 0,
        alias: 'w'
      },
      'worker-concurrency': {
        type: 'boolean',
        default: false,
        alias: 'wc'
      },
      'fail-on-page-error': {
        type: 'boolean',
        default: false
      }
    }
  })

  const resolve = require('path').resolve
  const existsSync = require('fs').existsSync
  const store = new (require('data-store'))('nuxt-generate-cluster')

  const rootDir = resolve(cli.input[0] || '.')
  const nuxtConfigFile = resolve(rootDir, cli.flags.config)

  let options = null
  if (existsSync(nuxtConfigFile)) {
    const esm = require('esm')(module, {
      cache: false,
      cjs: {
        cache: true,
        vars: true,
        namedExports: true
      }
    })

    delete require.cache[nuxtConfigFile]
    options = esm(nuxtConfigFile)
    options = options.default || options
  } else if (cli.flags.config && cli.flags.config !== 'nuxt.config.js') {
    console.error(`> Could not load config file ${cli.flags.config}`) // eslint-disable-line no-console
    process.exit(1)
  }

  if (!options) {
    cli.showHelp()
  }

  options.rootDir = typeof options.rootDir === 'string' ? options.rootDir : rootDir
  options.dev = false // Force production mode (no webpack middleware called)

  let params
  if (cli.flags.params) {
    try {
      params = JSON.parse(cli.flags.params)
    } catch (e) {}

    params = params || require('querystring').parse(cli.flags.params)
  }

  const countFlags = (flag) => {
    return cli.flags[flag] === true
      ? 1
      : (
        Array.isArray(cli.flags[flag])
          ? cli.flags[flag].length
          : 0
      )
  }

  const storeTime = (key, time) => {
    timers[key] = time || Math.round(new Date().getTime() / 1000)
    store.set(timers)
    store.save()
  }

  const timers = Object.assign({
    lastStarted: 0,
    lastBuilt: 0,
    lastFinished: 0
  }, store.data || {})

  const { Master } = require('..')

  // require consola after importing Master
  const consola = require('consola')
  consola.addReporter({
    log(logObj) {
      if (logObj.type === 'fatal') {
        // Exit immediately on fatal error
        // the error itself is already printed by the other reporter
        // because logging happens sync and this reporter is added
        // after the normal one
        process.exit(1)
      }
    }
  })

  storeTime('lastStarted')
  const master = new Master(options, {
    adjustLogLevel: countFlags('v') - countFlags('q'),
    workerCount: cli.flags.workers,
    workerConcurrency: cli.flags.workerConcurrency,
    failOnPageError: cli.flags.failOnPageError
  })

  master.hook('built', (params) => {
    storeTime('lastBuilt')
  })

  master.hook('done', ({ duration, errors, workerInfo }) => {
    storeTime('lastFinished')

    consola.log(`HTML Files generated in ${duration}s`)

    if (errors.length) {
      const report = errors.map(({ type, route, error }) => {
        /* istanbul ignore if */
        if (type === 'unhandled') {
          return `Route: '${route}'\n${error.stack}`
        } else {
          return `Route: '${route}' thrown an error: \n` + JSON.stringify(error)
        }
      })
      consola.error('==== Error report ==== \n' + report.join('\n\n'))
    }
  })

  params = Object.assign({}, store.data || {}, params || {})
  master.run({ build: cli.flags.build, params })
} else {
  const { Worker } = require('..')
  Worker.start()
}
