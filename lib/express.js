/*
 * Copyright (c) 2012-2015 Digital Bazaar, Inc. All rights reserved.
 */
var async = require('async');
var bedrock = require('bedrock');
var bedrockServer = require('bedrock-server');
var bodyParser = require('body-parser');
var cors = require('cors');
var express = require('express');
var morgan = require('morgan');
var path = require('path');

// load config defaults
require('./config');

// module api
var api = {express: express, middleware: {}};
module.exports = api;

// modify express to allow multiple view roots
_allowMultipleViewRoots();

// create express server
var server = api.app = express();

// expose middleware singletons
api.middleware.morgan = morgan;
api.middleware['express-session'] = require('express-session');

// redefine logger token for remote-addr to use express-parsed ip
// (includes X-Forwarded-For header if available)
morgan.token('remote-addr', function(req) {
  return req.ip;
});

// default jsonld mimetype
express.static.mime.define({'application/ld+json': ['jsonld']});

// track when bedrock is ready to attach express
bedrock.events.on('bedrock.ready', function() {
  // attach express to TLS
  bedrockServer.servers.https.on('request', server);
});

// setup server on bedrock start
bedrock.events.on('bedrock.start', init);

function init(callback) {
  async.auto({
    init: function(callback) {
      bedrock.events.emit('bedrock-express.init', server, callback);
    },
    beforeLogger: ['init', function(callback) {
      // basic config
      server.enable('trust proxy');
      server.disable('x-powered-by');
      bedrock.events.emit('bedrock-express.configure.logger', server, callback);
    }],
    logger: ['beforeLogger', function(callback, results) {
      if(results.beforeLogger === false) {
        return callback();
      }
      var accessLogger = bedrock.loggers.get('access');
      server.use(morgan('combined', {
        stream: {write: function(str) {accessLogger.log('info', str);}}
      }));
      callback();
    }],
    beforeBodyParser: ['logger', function(callback) {
      server.use(require('method-override')());
      bedrock.events.emit(
        'bedrock-express.configure.bodyParser', server, callback);
    }],
    bodyParser: ['beforeBodyParser', function(callback, results) {
      if(results.beforeBodyParser === false) {
        return callback();
      }
      // parse application/json, application/*+json
      server.use(bodyParser.json({type: ['json', '+json']}));
      // parse application/x-www-form-urlencoded
      // extended transforms ?foo[baz][bar]=1 into: {foo:{baz:{bar:1}}
      server.use(bodyParser.urlencoded({extended: true}));
      callback();
    }],
    beforeCookieParser: ['bodyParser', function(callback) {
      bedrock.events.emit(
        'bedrock-express.configure.cookieParser', server, callback);
    }],
    cookieParser: ['bodyParser', function(callback, results) {
      if(results.bodyParser === false) {
        return callback();
      }
      server.use(require('cookie-parser')(
        bedrock.config.express.session.secret));
      callback();
    }],
    beforeSession: ['cookieParser', function(callback) {
      bedrock.events.emit(
        'bedrock-express.configure.session', server, callback);
    }],
    session: ['beforeSession', function(callback, results) {
      if(results.beforeSession === false) {
        return callback();
      }
      if(bedrock.config.express.useSession) {
        server.use(api.middleware['express-session'](
          bedrock.config.express.session));
      }
      callback();
    }],
    beforeStatic: ['session', function(callback) {
      bedrock.events.emit('bedrock-express.configure.static', server, callback);
    }],
    static: ['beforeStatic', function(callback, results) {
      if(results.beforeStatic === false) {
        return callback();
      }
      // compress static content
      server.use(require('compression')());
      // add each static path
      var logger = bedrock.loggers.get('app');
      for(var i = bedrock.config.express.static.length - 1; i >= 0; --i) {
        var cfg = bedrock.config.express.static[i];
        if(typeof cfg === 'string') {
          cfg = {route: '/', path: cfg};
        }
        // setup cors
        var corsHandler = null;
        if('cors' in cfg) {
          if(typeof cfg.cors === 'boolean' && cfg.cors) {
            // if boolean and true just use defaults
            corsHandler = cors();
          } else {
            // if object, use as cors config
            corsHandler = cors(cfg.cors);
          }
        }

        var p = path.resolve(cfg.path);
        if(cfg.file) {
          // serve single file
          logger.debug('serving route: "' + cfg.route +
            '" with file: "' + p + '"');
          if(corsHandler) {
            server.use(cfg.route, corsHandler);
          }
          server.use(cfg.route, _serveFile(p));
        } else {
          // serve directory
          logger.debug('serving route: "' + cfg.route +
            '" with dir: "' + p + '"');
          if(corsHandler) {
            server.use(cfg.route, corsHandler);
          }
          server.use(cfg.route, express.static(
            p, bedrock.config.express.staticOptions));
        }
      }
      callback();
    }],
    beforeCache: ['static', function(callback) {
      bedrock.events.emit('bedrock-express.configure.cache', server, callback);
    }],
    cache: ['beforeCache', function(callback, results) {
      if(results.beforeCache === false) {
        return callback();
      }
      // done after static to prevent caching non-static resources only
      server.use(function(req, res, next) {
        res.header('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.header('Pragma', 'no-cache');
        res.header('Expires', '0');
        next();
      });
      callback();
    }],
    beforeRouter: ['cache', function(callback) {
      bedrock.events.emit('bedrock-express.configure.router', server, callback);
    }],
    router: ['beforeRouter', function(callback) {
      callback();
    }],
    beforeRoutes: ['router', function(callback) {
      bedrock.events.emit('bedrock-express.configure.routes', server, callback);
    }],
    routes: ['beforeRoutes', function(callback, results) {
      if(results.beforeRoutes === false) {
        return callback();
      }
      callback();
    }],
    errorHandlers: ['routes', function(callback) {
      bedrock.events.emit(
        'bedrock-express.configure.errorHandlers', server, callback);
    }],
    beforeUnhandledErrorHandler: ['errorHandlers', function(callback) {
      bedrock.events.emit(
        'bedrock-express.configure.unhandledErrorHandler', server, callback);
    }],
    unhandledErrorHandler: [
      'beforeUnhandledErrorHandler', function(callback, results) {
      if(results.beforeUnhandledErrorHandler === false) {
        return callback();
      }
      if(bedrock.config.express.dumpExceptions) {
        server.use(require('errorhandler')());
      } else {
        // default error handler
        server.use(function(err, req, res, next) {
          // if err.status is set, respect it and the error message
          var msg = 'Internal Server Error';
          if(err.status) {
            res.statusCode = err.status;
            msg = err.message;
          }
          // set default status code 500 and error message
          if(res.statusCode < 400) {
            res.statusCode = 500;
          }
          // cannot actually respond
          if(res._header) {
            return req.socket.destroy();
          }
          res.setHeader('Content-Type', 'text/plain');
          res.end(msg);
        });
      }
      callback();
    }],
    beforeStart: ['unhandledErrorHandler', function(callback) {
      bedrock.events.emit('bedrock-express.start', server, callback);
    }],
    start: ['beforeStart', function(callback) {
      // allows modules to attach to bedrock-express start event before ready
      callback();
    }],
    ready: ['start', function(callback) {
      bedrock.events.emit('bedrock-express.ready', server, callback);
    }]
  }, function(err) {
    callback(err);
  });
}

// creates middleware for serving a single static file
function _serveFile(file) {
  return function(req, res) {
    res.sendFile(file, bedrock.config.express.staticOptions);
  };
}

// allows multiple view root paths to be used
function _allowMultipleViewRoots() {
  var View = require('express/lib/view');
  var old = View.prototype.lookup;
  View.prototype.lookup = function(path) {
    var self = this;
    var root = self.root;
    // if root is an array, try each root in reverse order until path exists
    if(Array.isArray(root)) {
      var foundPath;
      for(var i = root.length - 1; i >= 0; --i) {
        self.root = root[i];
        foundPath = old.call(self, path);
        if(foundPath) {
          break;
       }
      }
      self.root = root;
      return foundPath;
    }
    // fallback to standard behavior, when root is a single directory
    return old.call(self, path);
  };
}
