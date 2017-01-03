
var sg      = require('sgsg');
var _       = sg._;

var express = require('express');
var app     = express();
var router  = express.Router();
var server  = require('http').Server(app);
var io      = require('socket.io')(server);
var fs      = require('fs');

var subRoom = io.of('/substdouterr');

var mkDebug = require('debug');
var debug   = mkDebug('joinstreams');

var ARGV    = sg.ARGV();

if (!ARGV.port) { console.error("Must provide --port"); process.exit(1); }

server.listen(ARGV.port, function() { console.log({listeningOn: ARGV.port}); });

router.use(function(req, res, next) {
  debug("req: %s", req.url);
  return next();
});


subRoom.on('connection', function(socket) {
});

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

