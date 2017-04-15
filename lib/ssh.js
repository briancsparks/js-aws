
/**
 *  Use SSH to run commands on other instances.
 */

var sg          = require('sgsg');
var _           = sg._;
var io          = require('socket.io-client');
var chalk       = sg.extlibs.chalk;
var mkDebug     = require('debug');
var debug       = mkDebug('jsaws::ssh');
var ARGV        = sg.ARGV();

var sshLib      = {};

var sshOptions  = [
  '-o', 'StrictHostKeyChecking no',
  '-o', 'UserKnownHostsFile=/dev/null',
  '-o', 'ConnectTimeout=1'
];

sshLib.sshRun = function(argv, context, callback) {

  var userCommand       = argv.user_command   || argv.command;
  var userArgs          = argv.user_args      || argv.args        || [];
  var ip                = argv.ip;
  var message           = argv.message        || argv.msg         || 'run';
  var name              = argv.name           || ip;
  var fail              = argv.fail           || sg.mkFailFn(callback);
  var maxRuns           = argv.maxRuns        || argv.max         || 6;
  var useSocketIo       = argv.socket_io      || argv.socketio    || false;

  if (!userCommand) {
    return callback("Error: Need command.");
  }

  // TODO: listen on stdout for a magic string that it is listening
  sg.exec('node', ['joinstdouterr.js', '8080'], function(){});

  var socket            = io.connect('http://localhost:8080');
  var command           = [userCommand].concat(userArgs).join(' ');

  var start = _.now(), finalCode, finalCount;
  return sg.until(function(again, last, count, elapsed) {
    finalCount = count;
    if (count > maxRuns) { return fail("Script ran too many times"); }

    var sshArgs = sshOptions.concat([ip, '-A', command]);

    if (!useSocketIo) {
      return awsSpawn('/usr/bin/ssh', sshArgs, name, message, function(code) {
        finalCode = code;

        if (code === 255) { again.uncount(); }              // ssh returns with 255 when it could not exec the script, or connection was lost.
        if (code === 253) { again.uncountSometimes(); }     // The script can exit with 253 to indicate a reboot, or other.

        if (code === 0)   { return last(); }
        return again(1000);
      });
    } else {
      return sg.spawnEz('/usr/bin/ssh', sshArgs, {
        newline : false,

        stderr  : function(line) { /* debug(line); */ socket.emit('stderr', {payload:line, tags: _.extend({stderr:true}, sg.kv(name, true), sg.kv(message, true))}); },
        stdout  : function(line) { /* debug(line); */ socket.emit('stdout', {payload:line, tags: _.extend({stdout:true}, sg.kv(name, true), sg.kv(message, true))}); },

        close: function(code) {
          finalCode = code;

          if (code === 255) { again.uncount(); }              // ssh returns with 255 when it could not exec the script, or connection was lost.
          if (code === 253) { again.uncountSometimes(); }     // The script can exit with 253 to indicate a reboot, or other.

          if (code === 0)   { return last(); }
          return again(1000);
        }
      });
    }
  }, function() {
    return callback(null, finalCode, _.now() - start, finalCount);
  });
};

var scpFiles = sshLib.scpFiles = function(filenames, destDir, ip, displayIp, callback) {
  if (!_.isArray(filenames)) { return scpFiles([filenames], destDir, ip, displayIp, callback); }

  var scpArgs = sshOptions.concat([filenames]);
  scpArgs.push(ip+":"+destDir);

  var start = _.now(), finalCount;
  return sg.until(function(again, last, count, elapsed) {
    finalCount = count;
    return sg.spawnEz('/usr/bin/scp', args, {
      newline : true,

      stderr  : function(line) { process.stderr.write(chalk.red(displayIp)+' scp - '+chalk.red(line)); },
      stdout  : function(line) { process.stdour.write(chalk.cyan(displayIp)+' scp - '+chalk.reset(line)); },

      close   : function(code) {

        if (code === 0)         { return last(); }
        if (code === 255)       { again.uncount(); }

        return again(1000);
      }
    });
  }, function() {
    return callback(null, _.now() - start, finalCount);
  });
};

sshLib.awsSpawn = function() {
  return awsSpawn.apply(this, arguments);
};

_.each(sshLib, function(value, key) {
  exports[key] = value;
});

var okErrors = [
  /^dpkg-preconfigure: unable to re-open stdin:/,
  /^debconf: unable to initialize frontend:/,
  /^debconf: \(Dialog frontend will not work on a dumb terminal/,
  /^debconf: \(This frontend requires a controlling tty./,
  /^debconf: falling back to frontend:/
];

function noFilter(line) {
  return true;
}

function filterStderr(line) {
  var i, len;

  for (i = 0, len = okErrors.length; i < len; i += 1) {
    if (okErrors[i].exec(line)) {
      return false;
    }
  }

  // If we get here, display it
  return true;
}

function makeFailFn(callback) {
  return function(err) {
    // TODO: Big banner for failure
    return callback(err);
  };
}

var currBuildBlock = '';

function sshStdxyz(xyz, displayIp_, displayMsg_, labelColor, contentColor, filterFn) {
  var displayIp   = sg.pad(displayIp_, 15);
  var displayMsg  = sg.pad(displayMsg_, 20);

  if (ARGV.quiet || ARGV.q) {
    return function(){};
  }

  /* otherwise */
  if (sg.verbosity() === 1) {
    return function(line) {
      if (!filterFn(line)) { return; }
      process[xyz].write('.');
    };
  }

  /* otherwise */
  return function(line) {
    var m;
    if ((m = line.replace('\n', '').match(/^(yoshi|jsaws)-build-block=(.*)$/))) {
      currBuildBlock = m[2];
    } else if ((m = line.replace('\n', '').match(/^(yoshi|jsaws)-build-block-done=(.*)$/))) {
      currBuildBlock = '';
    }

    if (!filterFn(line)) { return; }
    process[xyz].write(chalk[labelColor](displayIp) +  ' ' + displayMsg + ': ' + sg.rchop(currBuildBlock, 15, 15) + ' - ' + chalk[contentColor](line));
  };
}

function sshStdout(displayIp, displayMsg) {
  return sshStdxyz('stdout', displayIp, displayMsg, 'cyan', 'reset', noFilter);
}

function sshStderr(displayIp, displayMsg) {
  return sshStdxyz('stderr', displayIp, displayMsg, 'red', 'red', filterStderr);
}

function awsSpawn(command, args, displayIp, displayMsg, callback) {
  return sg.spawnEz(command, args, {
    newline : true,

    stderr  : sshStderr(displayIp, displayMsg),
    stdout  : sshStdout(displayIp, displayMsg),

    close: function(code) {
      return callback.apply(this, arguments);
    }
  });
}

