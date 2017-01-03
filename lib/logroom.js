
var sg      = require('sgsg');
var _       = sg._;
var mkDebug = require('debug');
var debug   = mkDebug('logroom');

var ARGV    = sg.ARGV();

main();

function main() {

  if (!ARGV.room)   { return die("Need --room="); }

  var io          = require('socket.io-client');
  var socket      = io.connect('http://localhost:8080/'+ARGV.room);

  socket.on('message', function(msg) {
    debug("msg: |%s|", msg);
  });

}

