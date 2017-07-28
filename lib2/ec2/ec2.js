
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

var argvExtract         = sg.argvExtract;
var die                 = sg.die;
var awsService          = awsServiceLib.awsService;
var extractServiceArgs  = awsServiceLib.extractServiceArgs;

var flattenAndLabel;

var ec2     = {};
var raEc2;                /* Gets built from the ec2 object at the end of this file */

/**
 *  The common part of all of the ec2 describeXyz APIs.
 *
 *  This function will take care of all of the multi-account stuff, as well as the until() call
 *  for any of the describe functions.
 */
var describe = function(argv_, context, awsName, callback, awsFnName_, awsServiceName_) {
  var argv            = sg.deepCopy(argv_);
  var awsFnName       = awsFnName_                 || 'describe'+awsName;
  var accts           = (sg.extract(argv, 'accts') || process.env.JSAWS_AWS_ACCT_EXTRA_CREDS || '').split(',');
  var awsServiceName  = awsServiceName_            || 'EC2';
  var onlyOneAcct     = sg.extract(argv, 'onlyOneAcct');

  var accountItems = {};

  return sg.__eachll(accts, function(acct, nextAcct) {

    // acct is 'prod:123456789012/projc-yournamehere' or 'dev'
    parts         = acct.split(':');
    var acctName  = parts[0];
    var iam       = parts[1];

    // Sometimes you have to force this function only to use one acct
    if (onlyOneAcct && (onlyOneAcct !== acctName)) {
      return nextAcct();
    }

    // The AWS EC2 service for the acct
    var awsEc2 = awsService(awsServiceName, sg.kv('iam', iam));

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
          console.error(argv);
          return die(err, callback, 'lib2ec2.describe.'+awsName+' with: '+awsFnName+' using: '+iam);
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

ec2.getVpcPeeringConnections = function(argv, context, callback) {
  return describe(argv, context, 'VpcPeeringConnections', function(err, peeringGroup) {
    if (err) { return die(err, callback, 'lib2ec2.getInstances.describe'); }

    var result = {};

    _.each(peeringGroup, function(peerings) {
      var acctName = peerings.accountName;
      delete peerings.accountName;

      _.each(peerings, function(peering, id) {
        result[peering.VpcPeeringConnectionId] = _.extend({accountName: acctName}, peering);
      });
    });

    return callback(null, result);
  });
};

/**
 *  For all practical purposes, this will assign a FQDN to an instance, but in reality
 *  what is happening is that the DNS entry remains the same (associated with the EIP),
 *  but the EIP gets associated with the instance. This is better than waiting for the
 *  DNS change to propigate.
 *
 *  This function looks into all available accounts, and 'just does' the right thing to
 *  get traffic flowing to the instance.
 *
 *      ./assignFqdnToInstance --instance-id=i-02bb9eed506bf6ea0 --fqdn=blue-pub.mobilewebassist.net
 */
ec2.moveEipForFqdn = function(argv, context, callback) {

  var instanceId      = argvExtract(argv, 'instance-id,instance,id');
  var fqdn            = argvExtract(argv, 'fqdn');

  if (!instanceId)      { return sg.die('ENOINSTANCEID', callback, 'moveEipForFqdn'); }
  if (!fqdn)            { return sg.die('ENOFQDN',       callback, 'moveEipForFqdn'); }

  //
  // Get all of our Elastic IPs
  //
  return describe(argv, context, 'Addresses', function(err, addresses_) {
    if (err)          { return sg.die(err, callback, 'moveEipForFqdn'); }

    var addresses = flattenAndLabel(addresses_);

    //
    // On our way to getting all of our DNS entries, we first have to go through the zones
    //

    // We get all of the zones, and the shorten the list
    return describe({}, context, 'HostedZones', function(err, zones_) {
      if (err)          { return sg.die(err, callback, 'moveEipForFqdn.listHostedZones'); }

      // Filter out all the extra domain names
      var zones = _.filter(flattenAndLabel(zones_), function(zone) {
        if (zone.accountName === 'pub' && zone.Name === 'mobilewebprint.net.') { return false; }  // **** This one is a faker
        return !!zone.Name.match(/mobile(web|dev)/i) && zone.Config.PrivateZone != true;
      });

      // We should have 4 zones now

      // Loop over each of our 4 domain names
      var resourceRecordSets = [];
      sg.__each(zones, function(zone, next) {

        // Note that we have to tell `describe()` only to make the call to one account
        return describe({HostedZoneId: zone.Id, onlyOneAcct: zone.accountName}, context, 'ResourceRecordSets', function(err, rrs) {
          if (err)          { return sg.die(err, callback, 'moveEipForFqdn.listResourceRecordSets'); }

          // Add to the big-ol list
          resourceRecordSets = resourceRecordSets.concat(flattenAndLabel(rrs));
          return next();
        }, 'listResourceRecordSets', 'Route53');

      }, function() {

        // Collect up all of the 'A' records
        var rrsForFqdn = [];
        var cnames = [];
        _.each(resourceRecordSets, function(resourceRecords) {
          var rr = resourceRecords;

          if (rr.Type === 'CNAME') {
            //console.error(rr.Name);
            if (rr.Name === fqdn+'.') {
            }
          } else if (rr.Type === 'A') {
            //console.error(rr.Name);
            if (rr.Name === fqdn+'.') {
              rrsForFqdn.push(rr);
            }
          } else if (rr.Type === 'NS' || rr.Type === 'SOA') {
          } else {
            console.error('missing', rr);
          }
        });

        // Loop over all the records, and addresses and find the match
        var addrs = [];
        _.each(rrsForFqdn, function(rrSet) {
          _.each(rrSet.ResourceRecords, function(rr) {
            _.each(addresses, function(address) {
              if (address.PublicIp === rr.Value) {
                addrs.push(address);
              }
            });
          });
        });

        if (addrs.length !== 1) {
          return sg.die('ENOTONE', callback, '');
        }

        // Note that we have to use onlyOneAcct here, too
        var aaParams = {AllocationId : addrs[0].AllocationId, InstanceId : instanceId, onlyOneAcct: addrs[0].accountName};
        return describe(aaParams, context, 'Address', function(err, result) {
          if (err) { return die(err, callback, 'libEc2.assignFqdnToInstance.associateAddress'); }

          return callback(err, result);
        }, 'associateAddress');

      });
    }, 'listHostedZones', 'Route53');
  });
};


flattenAndLabel = function(itemses) {
  var result = [];

  _.each(itemses, function(b) {
    var accountName = sg.extract(b, 'accountName');
    _.each(b, function(c) {
      c.accountName = accountName;
      result.push(c);
    });
  });

  return result;
};

raEc2 = ra.wrap(ec2);

_.each(ec2, function(value, key) {
  exports[key] = value;
});

