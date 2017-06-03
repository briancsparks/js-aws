
/**
 *  Lib2 - Ec2.js
 *
 *  An Ec2.js version once I knew how to do it right.
 */
var sg                  = require('sgsg');
var _                   = sg._;
var ra                  = require('run-anywhere');
var awsJsonLib          = require('aws-json');
var awsServiceLib       = require('../../lib/service/service');

var die                 = sg.die;
var awsService          = awsServiceLib.awsService;
var extractServiceArgs  = awsServiceLib.extractServiceArgs;

var ec2     = {};
var raEc2;                /* Gets build from the ec2 object at the end of this file */

/**
 *  The common part of all of the ec2 describeXyz APIs.
 *
 *  This function will take care of all of the multi-account stuff, as well as the until() call
 *  for any of the describe functions.
 */
var describe = function(argv_, context, awsName, callback, awsFnName_) {
  var argv            = sg.deepCopy(argv_);
  var awsFnName       = awsFnName_                 || 'describe'+awsName;
  var accts           = (sg.extract(argv, 'accts') || process.env.JSAWS_AWS_ACCT_EXTRA_CREDS || '').split(',');

  var accountItems = {};

  return sg.__eachll(accts, function(acct, nextAcct) {

    // acct is 'prod:123456789012/projc-yournamehere' or 'dev'
    parts         = acct.split(':');
    var acctName  = parts[0];
    var iam       = parts[1];

    // The AWS EC2 service for the acct
    var awsEc2 = awsService('EC2', sg.kv('iam', iam));

    // Return results by acct name
    accountItems[acctName] = {};

    // Run until we get a result
    return sg.until(function(again, last, count) {
      if (count > 12) { return die(err, callback, 'lib2ec2.describe.'+awsName+'too-many-tries'); }

      // Like ec2.describeInstances(...)
      return awsEc2[awsFnName](argv, function(err, items) {
        if (err) {
          if (err.code === 'RequestLimitExceeded')    { return again(250); }

          /* otherwise */
          return die(err, callback, 'li2ec2.describe.'+awsName);
        }

        // Fixup the AWS-style JSON
        accountItems[acctName] = awsJsonLib.awsToJsObject(items);

        // Usually, when asking for describeFoo(), the result will have a 'Foo' attr, but not always,
        // for example, describeInstances has items.Reservations
        accountItems[acctName] = accountItems[acctName][awsName] || accountItems[acctName];

        // Got it... go to next acct
        return last();
      });
    }, nextAcct);

  }, function() {
    var result = [];
    _.each(accountItems, function(item, acctName) {
      result.push(sg.kv(item, 'accountName', acctName));
    });
    return callback(null, result);
  });
};

/**
 *  The js-aws equivalent to AWS's ec2.describeInstances, but better.
 *
 *  Returns sane JSON.
 *  Unrolls the reservation objects.
 */
ec2.getInstances = function(argv, context, callback) {
  return describe(argv, context, 'Instances', function(err, reservationGroup) {
    if (err) { return die(err, callback, 'lib2ec2.getInstances.describe'); }

    // reservationGroup is [ { Reservations: { 'r-123': object(including Instances list) }, accountName: 'pub' }, { Reservations: { 'r-456': object(including Instances list) }, accountName: 'pub' }]

    var result = {};
    _.each(reservationGroup, function(reservations) {

      // reservations is just a single one of the above: { Reservations: { 'r-123': object(including Instances list) }, accountName: 'pub' }
      _.each(reservations.Reservations, function(reservation, reservationId) {

        // reservation is { ReservationId: 'abc', ..., Instances: { 'i-123': {...} } }
        _.each(reservation.Instances, function(instance, instanceId) {
          result[instanceId] = _.extend({accountName: reservations.accountName, ownerId: reservation.OwnerId}, instance);
        });
      });
    });

    return callback(null, result);
  });
};


raEc2 = ra.wrap(ec2);

_.each(ec2, function(value, key) {
  exports[key] = value;
});

