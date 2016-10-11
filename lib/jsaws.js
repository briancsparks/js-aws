
/**
 *  The main file for js-aws.
 */

var sg                  = require('sgsg');
var _                   = sg._;
var aws                 = require('aws-sdk');
var path                = require('path');
var awsJsonLib          = require('aws-json');
var helpers             = require('./helpers');

require('shelljs/global');

var argvGet             = sg.argvGet;
var deref               = sg.deref;
var die                 = sg.die;
var ipNumber            = helpers.ipNumber;
var dottedIp            = helpers.dottedIp;

var jsaws             = {};
var cachedAwsServices = {};
var configurators     = {};
var sysConfigurators  = {};

/**
 *  Since this is a general purpose JS-ification of AWS, it needs a handful of functions to
 *  know the desired configuration.
 *
 *  For example, given an IP, what is the service?  Different users will allocate space
 *  differently.
 */

/**
 *  Add a configuration - a configuration function.
 *
 *  @param {string} name            - The name of the configuration, like "serviceForIp".
 *  @param {Function} configurator  - The config function.
 */
jsaws.addConfigurator = function(name, configurator) {
  if (!name || !configurator) { return; }

  configurators[name] = configurator;
  return configurator;
};

/**
 *  Gets a configurator that the user has set, or a noop.
 */
var getUserConfigurator = jsaws.getUserConfigurator = function(name) {
  var result;
  if (configurators[name])            { return configurators[name]; }

  /* otherwise */
  return function() { return; }
};

/**
 *  Get a configuration - like given an IP, what is the service?
 */
var getConfig = jsaws.getConfig = function(name /*, ...*/) {
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

/**
 *
 */
var awsHasBeenConfigured = false;

/**
 *  Get credentials and other AWS config from one of the myraid places.
 */
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

/**
 *  Extra prep for the argv object.
 *
 *  Makes sure it has a region.
 */
jsaws.prep = function(argv) {
  argv.region   = argvGet(argv, 'region') || 'us-east-1';

  return argv;
};

/**
 *  Get the AWS EC2 object.
 */
jsaws.getEc2 = function(options_) {
  var options       = options_ || {};
  var aws           = jsaws.configAws(options);

  if (!cachedAwsServices.ec2) {
    cachedAwsServices.ec2 = new aws.EC2({region: options.region});
  }

  return cachedAwsServices.ec2;
};

/**
 *  Get the AWS IAM object.
 */
jsaws.getIam = function(options_) {
  var options       = options_ || {};
  var aws           = jsaws.configAws(options);

  if (!cachedAwsServices.iam) {
    cachedAwsServices.iam = new aws.IAM({region: options.region});
  }

  return cachedAwsServices.iam;
};

/**
 *  Invoke one of the describe-X functions.
 *
 *  @param {Object} argv          - Run-anywhere style argv object.
 *  @param {Object} context       - Run-anywhere style context object.
 *  @param {Function} context     - Run-anywhere style callback.
 *  @param {string} awsName       - The name of the thing to be described, like "Instances".
 *  @param {string} [awsFnName]   - Sometimes, you cannot just paste "describe"+awsName to get the right function.
 */
var getAll = jsaws.getAll = function(argv, context, callback, awsName /*, awsFnName*/) {
  var args          = _.rest(arguments, 4);
  var awsFnName     = args.pop();

  // If the caller did not provide the aws API name, build it
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

/**
 *  Invoke one of the describe-X functions.
 *
 *  Unlike getAll, this function passes the argv object to the describe-X API.
 *
 *  @param {Object} argv          - Run-anywhere style argv object.
 *  @param {Object} context       - Run-anywhere style context object.
 *  @param {Function} context     - Run-anywhere style callback.
 *  @param {string} awsName       - The name of the thing to be described, like "Instances".
 *  @param {string} [awsFnName]   - Sometimes, you cannot just paste "describe"+awsName to get the right function.
 */
var getX2 = jsaws.getX2 = function(argv, context, callback, awsName /*, awsFnName*/) {
  var args          = _.rest(arguments, 4);
  var awsFnName     = args.pop();

  if (!awsFnName) {
    awsFnName = 'describe'+awsName;
  }

  argv              = jsaws.prep(argv);
  var awsEc2        = jsaws.getEc2(argv);

  delete argv.region;

  return awsEc2[awsFnName](argv || {}, function(err, x) {
    if (err) { return die(err, callback, 'getX2.awsEc2.'+awsFnName); }

    var result = awsJsonLib.awsToJsObject(x);
    result = result[awsName] || result;
    return callback(null, result);
  });
};

/**
 *  Here are the "stock" configurators.
 */

/**
 *  Return the stack name for the VPC.
 */
sysConfigurators.stackForVpc = function(vpc) {
  // "namespace-stack-generation"
  var m = /^([^-]+)-([^-]+)-([^-]+)/.exec(deref(vpc, 'Tags.aws.cloudformation.stackName'));
  if (m) {
    return m[2];
  }

  /* otherwise */
  return;
};

/**
 *  Returns the service for the IP address.
 *
 *  @param {string} ip - The IP address.
 *
 *  3       : bation
 *  4-9     : util
 *  10-15   : web
 *  16-63   : rip
 *  64-199  : app
 *  200-219 : controller
 *  220-229 : db
 *
 *  251-    : admin
 */
sysConfigurators.serviceForIp = function(ip) {
  var octets = ip.split('.');

  if (+octets[3] === 3)    { return 'bastion'; }
  if (+octets[3] < 10)     { return 'util'; }
  if (+octets[3] < 16)     { return 'web'; }
  if (+octets[3] < 64)     { return 'rip'; }
  if (+octets[3] < 100)    { return 'app'; }    // app1
  if (+octets[3] < 110)    { return 'app'; }    // app
  if (+octets[3] < 200)    { return 'app'; }    // app2
  if (+octets[3] < 220)    { return 'controller'; }
  if (+octets[3] < 230)    { return 'db'; }
  if (+octets[3] >= 251)   { return 'admin'; }

  return 'app';
};

/**
 *  Returns the tier for the given IP address.
 *
 *  @param {string} ip - The IP address.
 */
sysConfigurators.tierForIp = function(ip) {
  var octets = ip.split('.');

  if (+octets[3] === 3)    { return 'web'; }    // bastion server is external facing
  if (+octets[3] < 10)     { return 'util'; }
  if (+octets[3] < 16)     { return 'web'; }
  if (+octets[3] < 64)     { return 'print'; }
  if (+octets[3] < 100)    { return 'app'; }    // app1
  if (+octets[3] < 110)    { return 'app'; }    // app
  if (+octets[3] < 200)    { return 'app'; }    // app2
  if (+octets[3] < 220)    { return 'app'; }
  if (+octets[3] < 230)    { return 'db'; }
  if (+octets[3] >= 251)   { return 'web'; }    // admin server is external facing

  return 'app';
};

/**
 *  Returns the service type for the IP address.
 *
 *  @param {string} ip - The IP address.
 */
sysConfigurators.serviceTypeForIp = function(ip) {
  var octets = ip.split('.');

  if (+octets[3] === 3)    { return 'bastion'; }
  if (+octets[3] < 10)     { return 'util'; }
  if (+octets[3] < 16)     { return 'web'; }
  if (+octets[3] < 64)     { return 'app'; }
  if (+octets[3] < 100)    { return 'app'; }    // app1
  if (+octets[3] < 110)    { return 'app'; }    // app
  if (+octets[3] < 200)    { return 'app'; }    // app2
  if (+octets[3] < 220)    { return 'app'; }
  if (+octets[3] < 230)    { return 'db'; }
  if (+octets[3] >= 251)   { return 'admin'; }

  return 'app';
};

/**
 *  Find all the service names.
 */
jsaws.serviceNames = function() {
  return 'util,db,web,rip,app,controller,admin'.split(',');
};

/**
 *  Finds the latest version of an AWS resource.
 *
 *  For any AWS resource that you need to lookup, add a tag. The name can be whatever you want.
 *  The value should be a number. This function looks through the collection and gives you back
 *  the one that has the highest number. The awsCollection must be aws-json-ified.
 */
jsaws.getLatest = function(awsCollection, tagName) {
  var result;

  var maxVersion = -1;
  _.each(awsCollection, function(item, key) {
    var version = deref(item, tagName);
    if (!version) { return; }

    version = +version;                 // Convert to a number
    if (version > maxVersion) {
      result     = item;
      maxVersion = version;
    }
  });

  return result;
}

// Export the jsaws library object
sg.exportify(module, jsaws);

// Export our ec2 wrapper
sg.exportify(module, require('./ec2/ec2.js'));

