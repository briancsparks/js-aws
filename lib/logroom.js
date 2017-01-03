
var sg      = require('sgsg');
var _       = sg._;
var io      = require('socket.io-client');
var mkDebug = require('debug');
var debug   = mkDebug('logroom');

var ARGV    = sg.ARGV();

main();

function main() {

  if (!ARGV.room)   { return sg.die("Need --room="); }

  var port        = ARGV.port   || 18080;

  var url         = 'http://localhost:'+port+'/'+ARGV.room;
  var socket      = io.connect(url);

  debug("Connecting to: %s", url);

  var handler = function(msg) {
    debug(msg);
  };

  socket.on('stdout', handler);
  socket.on('stderr', handler);

}

