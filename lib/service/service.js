
/**
 *
 */

var sg                  = require('sgsg');
var _                   = sg._;
var AWS                 = require('aws-sdk');

var argvGet             = sg.argvGet;
var argvExtract         = sg.argvExtract;

// Caches
var credsForRole        = {};
var services            = {};

// The credentials that this instance has normally
credsForRole.main       = new AWS.EC2MetadataCredentials({});
AWS.config.credentials  = credsForRole.main;

var lib                 = {};

/**
 *  Returns an AWS service object (like AWS.EC2), when given the ARN (or
 *  at least the acct and role, so we can build the ARN.
 */
var awsService = lib.awsService = function(serviceName, roleSessionName, acct, role, region_) {
  if (arguments.length === 2) {

    var roleSessionName_, acct_, role_, region_, parts;

    var argv              = arguments[1];
    var iamMiniArn        = argvGet(argv, 'iam-mini-arn,iam-arn,iam');

    if (iamMiniArn) {
      parts               = iamMiniArn.split('/');
      acct_               = parts[0];
      role_               = parts[1];
      roleSessionName_    = [role_, 'session'].join('_');
    } else {
      roleSessionName_    = argvGet(argv, 'role_session_name,session') || 'main';
      acct_               = argvGet(argv, 'account,acct');
      role_               = argvGet(argv, 'role');
    }

    region_               = argvGet(argv, 'region');

    // The AWS EC2 service
    return awsService(serviceName, roleSessionName_, acct_, role_, region_);
  }

  var region = region_ || 'us-east-1', creds;

  // If we have already built the service, and it is in the cache, return it.
  if (services[roleSessionName] && services[roleSessionName][serviceName]) {
    return services[roleSessionName][serviceName];
  }

  // We have to make the service; do we have to create the credentials, first?
  if (!credsForRole[roleSessionName]) {
    creds = {RoleArn: 'arn:aws:iam::'+acct+':role/'+role, RoleSessionName: roleSessionName};
    credsForRole[roleSessionName] = new AWS.TemporaryCredentials(creds);
  }

  // Must set this to the creds for the session
  AWS.config.credentials = credsForRole[roleSessionName];

  // Make and store the service
  services[roleSessionName] = services[roleSessionName] || {};
  return (services[roleSessionName][serviceName] = new AWS[serviceName]({region: region}));
};

/**
 *  Extracts (removes) the params that are meaningful for the awsService function.
 */
lib.extractServiceArgs = function(argv) {
  return {
    iam_mini_arn    : argvExtract(argv, 'iam-mini-arn,iam-arn,iam'),
    session         : argvExtract(argv, 'role_session_name,session'),
    account         : argvExtract(argv, 'account,acct'),
    role            : argvExtract(argv, 'role'),
    region          : argvExtract(argv, 'region')
  };
};

_.each(lib, function(value, key) {
  exports[key] = value;
});

