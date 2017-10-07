
/**
 *  JS-ification of IAM.
 */

var sg                  = require('sgsg');
var _                   = sg._;
var aws                 = require('aws-sdk');
var jsaws               = require('../jsaws');
var ra                  = require('run-anywhere');
var jsAwsService        = require('../service/service');
var awsService          = jsAwsService.awsService;

var argvGet             = sg.argvGet;
var extractServiceArgs  = jsAwsService.extractServiceArgs;

var iamLib              = {};

iamLib.getInstanceProfileForRole = function(argv_, roleName, context, callback) {
  var argv            = sg.deepCopy(argv_);

  var roleSessionName = argvGet(argv, 'role_session_name,session') || 'main';
  var acct            = argvGet(argv, 'account,acct');
  var role            = argvGet(argv, 'role');
  var region          = argvGet(argv, 'region');

  // The AWS EC2 service
  var awsIam;
  if (roleSessionName && acct && role) {
    awsIam = awsService('IAM', roleSessionName, acct, role, region);
  } else {
    awsIam = awsService('IAM', extractServiceArgs(argv));
  }

  var params = {
    RoleName      : roleName
  };
  return awsIam.listInstanceProfilesForRole(params, function(err, profiles) {
    if (err) { return callback(err); }

    var arn;
    _.each(profiles.InstanceProfiles, function(profile) {
      arn = profile.Arn;
    });

    return callback(null, arn);
  });
};

iamLib.getInstanceProfile = function(argv, context, callback) {
  argv              = jsaws.prep(argv);
  var awsIam        = jsaws.getIam(argv);

  var params = {
    RoleName      : argvGet(argv, 'role-name,role')
  };
  return awsIam.listInstanceProfilesForRole(params, function(err, profiles) {
    if (err) { return callback(err); }

    var arn;
    _.each(profiles.InstanceProfiles, function(profile) {
      arn = profile.Arn;
    });

    return callback(null, arn);
  });
};

_.each(iamLib, function(value, key) {
  exports[key] = value;
});


