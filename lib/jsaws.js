
var sg                  = require('sgsg');
var _                   = sg._;
var aws                 = require('aws-sdk');
var path                = require('path');
var awsJsonLib          = require('aws-json');

require('shelljs/global');

var argvGet             = sg.argvGet;
var deref               = sg.deref;

var jsaws             = {};
var cachedAwsServices = {};
var configurators     = {};
var sysConfigurators  = {};

jsaws.addConfigurator = function(name, configurator) {
  if (!name || !configurator) { return; }

  configurators[name] = configurator;
  return configurator;
};

var getUserConfigurator = jsaws.getUserConfigurator = function(name) {
  var result;
  if (configurators[name])            { return configurators[name]; }

  /* otherwise */
  return function() { return; }
};

jsaws.getConfig = function(name /*, ...*/) {
  var args      = _.rest(arguments, 1);
  var fn        = getUserConfigurator(name);
  var result    = fn.apply(this, args);

  if (!_.isUndefined(result)) { return result; }

  /* otherwise -- use default */
  if ((fn = sysConfigurators[name])) {
    return fn.apply(this, args);
  }

  return;
};

var awsHasBeenConfigured = false;
jsaws.configAws = function(options_) {
  var options = options_ || {};

  if (awsHasBeenConfigured) {
    return aws;
  }
  awsHasBeenConfigured = true;

  var profile, credFile;

  if (options.ec2key && options.ec2value) {
    aws.config.update({accessKeyId: options.ec2key, secretAccessKey: options.ec2value});
    return aws;
  }

  /* otherwise */
  if ((profile = options.profile)) {
    return readFromCredFile('', profile);
  }

  return aws;

  function readFromCredFile(filename, profile) {
    aws.config.credentials = new aws.SharedIniFileCredentials({profile: profile});
    return aws;
  }
};

jsaws.prep = function(argv) {
  argv.region   = argvGet(argv, 'region') || 'us-east-1';

  return argv;
};

jsaws.getEc2 = function(options_) {
  var options       = options_ || {};
  var aws           = jsaws.configAws(options);

  if (!cachedAwsServices.ec2) {
    cachedAwsServices.ec2 = new aws.EC2({region: options.region});
  }

  return cachedAwsServices.ec2;
};

var getX = jsaws.getX = function(argv, context, callback, awsName /*, awsFnName*/) {
  var args          = _.rest(arguments, 4);
  var awsFnName     = args.pop();

  if (!awsFnName) {
    awsFnName = 'describe'+awsName;
  }

  argv              = jsaws.prep(argv);
  var awsEc2        = jsaws.getEc2(argv);

  return awsEc2[awsFnName](function(err, x) {
    if (err) { return callback(err); }

    var result = awsJsonLib.awsToJsObject(x);
    result = result[awsName] || result;
    return callback(null, result);
  });
};

sysConfigurators.stackForVpc = function(vpc) {
  // "namespace-stack-generation"
  var m = /^([^-]+)-([^-]+)-([^-]+)/.exec(deref(vpc, 'Tags.aws.cloudformation.stackName'));
  if (m) {
    return m[2];
  }

  /* otherwise */
  return;
};

sysConfigurators.tierForIp = function(ip) {
  var octets = ip.split('.');

  if (octets[3] < 8)      { return 'util'; }
  if (octets[3] < 10)     { return 'db'; }
  if (octets[3] < 16)     { return 'web'; }
  if (octets[3] < 64)     { return 'print'; }
  if (octets[3] < 100)    { return 'app'; }    // app1
  if (octets[3] < 110)    { return 'app'; }    // app
  if (octets[3] < 150)    { return 'app'; }    // app2
  if (octets[3] >= 251)   { return 'app'; }

  return 'app';
};

sysConfigurators.serviceForIp = function(ip) {
  var octets = ip.split('.');

  if (octets[3] < 8)      { return 'util'; }
  if (octets[3] < 10)     { return 'db'; }
  if (octets[3] < 16)     { return 'web'; }
  if (octets[3] < 64)     { return 'rip'; }
  if (octets[3] < 100)    { return 'app'; }    // app1
  if (octets[3] < 110)    { return 'app'; }    // app
  if (octets[3] < 150)    { return 'app'; }    // app2
  if (octets[3] >= 251)   { return 'admin'; }

  return 'app';
};

sysConfigurators.serviceTypeForIp = function(ip) {
  var octets = ip.split('.');

  if (octets[3] < 8)      { return 'util'; }
  if (octets[3] < 10)     { return 'db'; }
  if (octets[3] < 16)     { return 'web'; }
  if (octets[3] < 64)     { return 'app'; }
  if (octets[3] < 100)    { return 'app'; }    // app1
  if (octets[3] < 110)    { return 'app'; }    // app
  if (octets[3] < 150)    { return 'app'; }    // app2
  if (octets[3] >= 251)   { return 'admin'; }

  return 'app';
};


sg.exportify(module, jsaws);
sg.exportify(module, require('./ec2/ec2.js'));

