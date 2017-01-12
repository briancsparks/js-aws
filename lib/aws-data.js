
/**
 *  Pump data into the aws-socket.
 */

var sg              = require('sgsg');
var _               = sg._;
var awsJsonLib      = require('aws-json');

// Logger
var mkDebug         = require('debug');
var debug           = mkDebug('aws-data');

// The ARGV object
var ARGV            = sg.ARGV();

var io              = require('socket.io-client');
var socket          = io.connect('http://localhost:12323');
var AWS             = require('aws-sdk');

var masterCreds     = new AWS.EC2MetadataCredentials({});
AWS.config.credentials = masterCreds;

var awsData = {};

var main = function() {

  //handleRole();

  var wait = function() {
    console.log("Flushing...");
    setTimeout(function() {
      socket.close();
    }, 1000);
  };

  var cmd = ARGV.command  || ARGV.cmd;
  if (cmd === 'describeInstances' || cmd === 'di') {
    describeInstances(ARGV, {}, wait);
  }

  if (cmd === 'describeVpcs' || cmd === 'dv') {
    describeVpcs(ARGV, {}, wait);
  }

};

var credCache_ = {};
var credCache = function(role, acct) {
  if (!role && !acct) {
    return masterCreds;
  }

  var name = acct+'/'+role;

  if (!credCache_[name]) {
    credCache_[name] = new AWS.TemporaryCredentials({RoleArn: 'arn:aws:iam::'+acct+':role/'+role, RoleSessionName: 'Role-'+role});
  }

  return credCache_[name];
};

var serviceCache_ = {};
var serviceCache = function(role_, acct_, service, fn) {
  var role  = role_ || 'null';
  var acct  = acct_ || 'null';
  var name = acct+'/'+role+'/'+service;

  if (!serviceCache_[name]) {
    AWS.config.credentials = credCache(role_, acct_);
    serviceCache_[name] = fn(AWS);
    AWS.config.credentials = masterCreds;
  }

  return serviceCache_[name];
};

var describeVpcs = awsData.describeVpcs = function(argv, context, callback) {
  var ec2 = serviceCache(argv.role, argv.acct, 'ec2', function(aws) { return new aws.EC2({region: ARGV.region || 'us-east-1'}); });

  return ec2.describeVpcs({}, function(err, vpcs_) {
    if (err)  { return callback(err); }

    /* otherwise */
    var vpcs = _.map(vpcs_.Vpcs, awsJsonLib.awsToJsObject);

    var result = _.extend(getTags(argv), {data:{vpcs: vpcs}});

    if (!argv.skipEmit) {
      socket.emit('aws-data', result);
    }

    return callback(null, result);
  });
};

var describeInstances = awsData.describeInstances = function(argv, context, callback) {
  var ec2 = serviceCache(argv.role, argv.acct, 'ec2', function(aws) { return new aws.EC2({region: ARGV.region || 'us-east-1'}); });

  var params = {
//    MaxResults  : 5
  };

  var instances = [];
  return sg.until(function(again, last) {
    return ec2.describeInstances(params, function(err, reservations) {

      if (err) {
        console.error(err);
        return callback(err);
      }
//      console.log(sg.inspect(reservations));

      _.each(reservations.Reservations || [], function(reservation) {
        _.each(reservation.Instances || [], function(instance) {
          instances.push(awsJsonLib.awsToJsObject(instance));
        });
      });
      console.log(instances.length);

      if (reservations.NextToken) {
        params.NextToken = reservations.NextToken;
        return again();
      }

      return last();
    });
  }, function() {
    console.log('done: ' + instances.length);
    var result = _.extend(getTags(argv), {data:{instances: instances}});

    if (!argv.skipEmit) {
      socket.emit('aws-data', result);
    }

    return callback(null, result);
  });
};

var getTags = function(argv) {
  var result = {};

  sg.setOn(result, 'acct', argv.acctName || argv.acct);

  return result;
};

_.each(awsData, function(value, key) {
  exports[key] = value;
});

if (sg.callMain(ARGV, __filename)) {
  main();
}

