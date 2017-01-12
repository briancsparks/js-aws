
/**
 *  Emit AWS data and events on a socket.io socket.
 */

var sg              = require('sgsg');
var _               = sg._;
var fs              = require('fs');
var urlLib          = require('url');

var awsData         = require('./aws-data');

// We will run it under an express server.
var express         = require('express');
var app             = express();
var router          = express.Router();
var server          = require('http').Server(app);
var io              = require('socket.io')(server);

var bodyParser      = require('body-parser');

// The room for listeners
var awsSubRoom      = io.of('/aws');

// Logger
var mkDebug         = require('debug');
var debug           = mkDebug('aws-socket');

// The ARGV object
var ARGV            = sg.ARGV();

var port            = ARGV.port || 12323;

var doDescribeVpcs;

server.listen(port, function() { console.log({listeningOn: port}); });

// We make a tiny middleware, so we can log any HTTP requests that we happen to receive
router.use(function(req, res, next) {
//  debug("req: %s", req.url);
  return next();
});

app.use(router);
app.use(bodyParser.urlencoded({extended:true}));
app.use(bodyParser.json());

app.get('/api/:awsApi', function(req, res) {
  debug("req: %s", req.url);

  if (req.params.awsApi === 'describeVpcs') {
    return doDescribeVpcs(req, res);
  }

  var apiFn = awsData[req.params.awsApi];

  if (!apiFn) {
    res.status(404).json({noSuchRoute: req.params.awsApi});
    return;
  }

  /* otherwise */
  var url = urlLib.parse(req.url, true);

  var argv = sg.deepCopy(url.query);
  argv.skipEmit = true;

  return apiFn(argv, {}, function(err, data) {
    if (err) { return res.status(500).json(err); }

    /* otherwise */
    res.json(data);
  });
});


// Accept connections to the room for the listeners
awsSubRoom.on('connection', function(socket) {
  debug("Accepting connection in room /aws");
});

// Accept connections for the broadcasters
io.on('connection', function (socket) {

  debug('on connection');
  socket.on('aws-data', function (data) {
    debug('data on socket');
    awsSubRoom.emit('data', data);
  });
});

var doAwsEmitData = function(apiName, argv, callback) {

  var apiFn = awsData[apiName];

  if (!apiFn) {
    return callback(sg.toError('NO_SUCH_API-'+apiName));
  }

  /* otherwise */
  return apiFn(argv, {}, function(err, data) {
    if (err) { console.error(err); return callback(sg.toError(err)); }

    /* otherwise */
    return callback(null, data);
  });
};

var doAwsData = function(apiName, argv_, callback) {

  var apiFn = awsData[apiName];

  if (!apiFn) {
    return callback(sg.toError('NO_SUCH_API-'+apiName));
  }

  /* otherwise */
  var argv = sg.deepCopy(argv_);
  argv.skipEmit = true;

  return apiFn(argv, {}, function(err, data) {
    if (err) { console.error(err); return callback(sg.toError(err)); }

    /* otherwise */
    return callback(null, data);
  });
};

doDescribeVpcs = function(req, res) {

  var url   = urlLib.parse(req.url, true);
  var argv  = sg.deepCopy(url.query);

  var vpcs = [];

  return sg.__run([function(next) {
    return doAwsEmitData('describeInstances', argv, function(err, instances) {
      return next();
    });
  }, function(next) {
    return doAwsEmitData('describeInstances', {acctName: 'dev'}, function(err, instances) {
      return next();
    });
  }, function(next) {
    return doAwsData(req.params.awsApi, argv, function(err, vpcs_) {
      if (err) { console.error(err); }
      else {
        console.log('vpcs:', vpcs_.acct, vpcs_.data.vpcs.length);
        vpcs.push(vpcs_);
      }
      return next();
    });
  }, function(next) {
    return doAwsData(req.params.awsApi, {acctName: 'dev'}, function(err, vpcs_) {
      if (err) { console.error(err); }
      else {
        console.log('vpcs:', vpcs_.acct, vpcs_.data.vpcs.length);
        vpcs.push(vpcs_);
      }
      return next();
    });
  }], function() {

    res.json(vpcs);

  });
};

    // res.status(404).json({noSuchRoute: req.params.awsApi});

