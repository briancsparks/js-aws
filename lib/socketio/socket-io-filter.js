
var sg      = require('sgsg');
var _       = sg._;
var io      = require('socket.io-client');
var mkDebug = require('debug');
var debug   = mkDebug('jsaws:siofilter');

var ARGV    = sg.ARGV();

var filter = {};

filter.filter = function(options_, fn) {
  var options = options_ || {};

  var host    = options.host || 'localhost';
  var port    = options.port || 18080;
  var room    = options.room || '';
  var tags    = options.tags || '';

  var url  = 'http://'+host+':'+port+'/'+room;

  debug("Connecting to: %s", url);
  var socket      = io.connect(url);

  tags = _.keys(sg.mkSet(tags));
  var handler = function(msg) {
    var msgTags = _.keys((msg && msg.tags) || []);
    if (_.intersection(tags, msgTags).length > 0) { return; }

    fn(msg);
  };

  socket.on('stdout', handler);
  socket.on('stderr', handler);
};

_.each(filter, function(value, key) {
  exports[key] = value;
});

if (process.argv[1] === __filename) {
  main();
}

function main() {

  if (!ARGV.room)   { return sg.die("Need --room="); }

  var port        = ARGV.port   || 18080;
  return filter.filter({room: ARGV.room, port:port}, function(msg) {
    console.log(msg && msg.payload);
  });

//  var url         = 'http://localhost:'+port+'/'+ARGV.room;
//  var socket      = io.connect(url);
//
//  debug("Connecting to: %s", url);
//
//  var handler = function(msg) {
//    debug(msg);
//  };
//
//  socket.on('stdout', handler);
//  socket.on('stderr', handler);

}

