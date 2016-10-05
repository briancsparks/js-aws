
/**
 *  JS-ification of IAM.
 */

var sg                  = require('sgsg');
var _                   = sg._;
var aws                 = require('aws-sdk');
var jsaws               = require('../jsaws');
var ra                  = require('run-anywhere');
var argvGet             = sg.argvGet;

var iamLib              = {};

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


