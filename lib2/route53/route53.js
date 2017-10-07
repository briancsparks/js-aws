
/**
 *
 */
const sg                      = require('sgsg');
const _                       = sg._;
const ra                      = sg.include('run-anywhere')  || require('run-anywhere');
const awsJsonLib              = sg.include('aws-json')      || require('aws-json');
const awsServiceLib           = require('../../lib/service/service');

const argvExtract             = sg.argvExtract;
const list                    = awsServiceLib.list;

var lib = {};

lib.listResourceRecordSets = function(argv_, context, callback) {
  var   u               = sg.prepUsage();

  var   argv            = sg.deepCopy(argv_);
  const onlyOneAcct     = argvExtract(argv, u('acct,only-one-acct', '=pub', 'The account to get the records from.')) || 'dev';

  var params = _.extend({
    onlyOneAcct,
    type    : 'ResourceRecordSets',
    fname   : 'listResourceRecordSets',
    service : 'Route53'
  }, argv);

  // Note that we have to tell `describe()` only to make the call to one account
  return list(params, context, function(err, rrs) {
    if (err)          { return sg.die(err, callback, 'route53.listResourceRecordSets'); }

    return callback(err, rrs);
  });
};

lib.listHostedZones = function(argv_, context, callback) {
  var   u               = sg.prepUsage();

  var   argv            = sg.deepCopy(argv_);
  const nameStr         = argvExtract(argv, 'name,fqdn,re') || 'mobile(we|de)[bvx]';
  const nameRe          = new RegExp(nameStr, 'i');

  var params = _.extend({
    type    : 'HostedZones',
    fname   : 'listHostedZones',
    service : 'Route53'
  }, argv);

  return list(params, context, function(err, zones_) {
    if (err)          { return sg.die(err, callback, 'listHostedZones.list'); }

    // Filter out all the extra domain names
    var zones = _.filter(zones_.items, function(zone) {
      if (zone.accountName === 'pub' && zone.Name === 'mobilewebprint.net.') { return false; }  // **** This one is a faker
      return !!zone.Name.match(nameRe) && zone.Config.PrivateZone != true;
    });

    return callback(null, zones);
  });
};


_.each(lib, (value, key) => {
  exports[key] = value;
});

