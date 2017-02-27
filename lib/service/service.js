
/**
 *
 */

var AWS                 = require('aws-sdk');

// Caches
var credsForRole        = {};
var services            = {};

// The credentials that this instance has normally
credsForRole.main       = new AWS.EC2MetadataCredentials({});
AWS.config.credentials  = credsForRole.main;

/**
 *  Returns an AWS service object (like AWS.EC2), when given the ARN (or
 *  at least the acct and role, so we can build the ARN.
 */
module.exports = function(serviceName, roleSessionName, acct, role, region_) {
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


