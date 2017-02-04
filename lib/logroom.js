
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
  var msgs        = ARGV.msgs   || 'stdout,stderr';

  var url         = 'http://localhost:'+port+'/'+ARGV.room;
  var socket      = io.connect(url);

  debug("Connecting to: %s", url);
  debug("Listening for %s", msgs);

  var handler = function(msg) {
    console.log(msg);
  };

  _.each(msgs.split(','), function(msg) {
    socket.on(msg, handler);
  });

}

