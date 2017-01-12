
/**
 *  A utility to listen for stdout and stderr (like from the ssh.js module), and
 *  broadcast the streams to listeners.
 *
 *  The code is mostly just to organize how socket.io is used.
 */

var sg      = require('sgsg');
var _       = sg._;
var fs      = require('fs');

// We will run it under an express server.
var express = require('express');
var app     = express();
var router  = express.Router();
var server  = require('http').Server(app);
var io      = require('socket.io')(server);

// The room for listeners
var subRoom = io.of('/substdouterr');

// Logger
var mkDebug = require('debug');
var debug   = mkDebug('joinstreams');

// The ARGV object
var ARGV    = sg.ARGV();

// We need the port
if (!ARGV.port) { console.error("Must provide --port"); process.exit(1); }

server.listen(ARGV.port, function() { console.log({listeningOn: ARGV.port}); });

// We make a tiny middleware, so we can log any HTTP requests that we happen to receive
router.use(function(req, res, next) {
  console.log("req: %s", req.url);
  return next();
});


// Accept connections to the room for the listeners
subRoom.on('connection', function(socket) {
  debug("Accepting connection in room");
});

// Accept connections for the broadcasters
io.on('connection', function (socket) {

  socket.on('stdout', function (data) {
    debug(JSON.stringify(data));
    subRoom.emit('stdout', data);
  });

  socket.on('stderr', function (data) {
    debug(JSON.stringify(data));
    subRoom.emit('stderr', data);
  });
});

