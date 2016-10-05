
/**
 *  Use SSH to run commands on other instances.
 */

var sg          = require('sgsg');
var _           = sg._;
var chalk       = sg.extlibs.chalk;
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
  var fail              = argv.fail           || function(){};
  var maxRuns           = argv.maxRuns        || argv.max         || 6;

  if (!userCommand) {
    return callback("Error: Need command.");
  }

  var command           = [userCommand].concat(userArgs).join(' ');

  var start = _.now(), finalCode, finalCount;
  return sg.until(function(again, last, count, elapsed) {
    finalCount = count;
    if (count > maxRuns) { return fail("Script ran too many times"); }

    var sshArgs = sshOptions.concat([ip, '-A', command]);
    return awsSpawn('/usr/bin/ssh', sshArgs, name, message, function(code) {
      finalCode = code;

      if (code === 255) { again.uncount(); }              // ssh returns with 255 when it could not exec the script, or connection was lost.
      if (code === 253) { again.uncountSometimes(); }     // The script can exit with 253 to indicate a reboot, or other.

      if (code === 0)   { return last(); }
      return again(1000);
    });
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

function makeFailFn(callback) {
  return function(err) {
    // TODO: Big banner for failure
    return callback(err);
  };
}

function sshStdxyz(xyz, displayIp_, displayMsg_, labelColor, contentColor) {
  var displayIp   = sg.pad(displayIp_, 15);
  var displayMsg  = sg.pad(displayMsg_, 12);

  if (ARGV.quiet || ARGV.q) {
    return function(){};
  }

  /* otherwise */
  if (sg.verbosity() === 1) {
    return function(line) {
      process[xyz].write('.');
    };
  }

  /* otherwise */
  return function(line) {
    process[xyz].write(chalk[labelColor](displayIp) +  ' ' + displayMsg + ' - ' + chalk[contentColor](line));
  };
};

function sshStdout(displayIp, displayMsg) {
  return sshStdxyz('stdout', displayIp, displayMsg, 'cyan', 'reset');
};

function sshStderr(displayIp, displayMsg) {
  return sshStdxyz('stderr', displayIp, displayMsg, 'red', 'red');
};

function awsSpawn(command, args, displayIp, displayMsg, callback) {
  return sg.spawnEz(command, args, {
    newline : true,

    stderr  : sshStderr(displayIp, displayMsg),
    stdout  : sshStdout(displayIp, displayMsg),

    close: function(code) {
      return callback.apply(this, arguments);
    }
  });
};

