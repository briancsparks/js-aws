
var sg      = require('sgsg');
var _       = sg._;
var io      = require('socket.io-client');
var mkDebug = require('debug');
var debug   = mkDebug('logroom');

var ARGV    = sg.ARGV();

main();

function main() {

  if (!ARGV.room)   { return sg.die("Need --room="); }

  var port        = ARGV.port   || 12323;
  var msgs        = ARGV.msgs   || 'stdout,stderr';

  var url         = 'http://localhost:'+port+'/'+ARGV.room;
  var socket      = io.connect(url);

  console.log("Connecting to: %s", url);

  debug("Connecting to: %s", url);

  var handler = function(msg) {
    console.log(sg.inspect(msg));
  };

  _.each(msgs.split(','), function(msg) {
    console.log('Listening for %s', msg);
    debug("Listening for %s", msg);
    socket.on(msg, handler);
  });

}

