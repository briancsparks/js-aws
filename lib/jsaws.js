
/**
 *  The main file for js-aws.
 */

var sg                  = require('sgsg');
var _                   = sg._;
var aws                 = require('aws-sdk');
var path                = require('path');
var awsJsonLib          = require('aws-json');
var helpers             = require('./helpers');
var superagent          = require('superagent');

var AWS                 = aws;      // The 'new' way to get creds for the other accts
var masterCredentials   = AWS.config.credentials  = new AWS.EC2MetadataCredentials({});

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
  return function() { return; };
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

var cachedEnvInfo;
/**
 *
 */
jsaws.envInfo = function(argv, context, callback) {
  if (cachedEnvInfo) { return callback(null, cachedEnvInfo); }

  var result = sg.deepCopy(process.env);

  sg.__runll([function(next) {
    return instanceInfo({path:'/latest/meta-data/iam/info'}, context, function(err, info) {
      var iamInfo = JSON.parse(info.text);

      result = _.extend(result, _.omit(iamInfo, 'Code', 'LastUpdated'));
      return next();
    });

  }, function(next) {
    return instanceInfo({path:'/latest/dynamic/instance-identity/document'}, context, function(err, info) {
      result = _.extend(result, JSON.parse(info.text));
      return next();
    });

  }, function(next) {
    return instanceInfo({path:'/latest/meta-data/mac'}, context, function(err, info) {
      result = _.extend(result, {mac:info.text});
      return next();
    });

  }], function() {
    return instanceInfo({path:'/latest/meta-data/network/interfaces/macs/'+result.mac+'/vpc-id'}, context, function(err, info) {
      result = _.extend(result, {vpcId:info.text});
      return callback(null, result);
    });
  });
};

var instanceInfo = jsaws.instanceInfo = function(argv, context, callback) {
  var path = argvGet(argv, 'path,info');

  return superagent.get('http://169.254.169.254'+path).end(function(err, res) {
    return callback(err, res);
  });
};

// ---------------------------------------------------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------------------------------------------------
//    BEGIN -- the old, complex way to get info from 2 or 3 accounts.
// ---------------------------------------------------------------------------------------------------------------------------------------

/**
 *  Extra prep for the argv object.
 *
 *  Makes sure it has a region.
 */
jsaws.prep = function(argv) {
  return _.extend({region: 'us-east-1'}, argv);
};

/**
 *  jsaws.AWS is for managing multiple accts - the "main" one (for the
 *  instance this code is running on), the prod one, and another that has
 *  the Route53.
 */
jsaws.AWS                     = {};
jsaws.AWS.cachedAwsServices   = {};
jsaws.AWS.cachedCredentials   = {};

/**
 *
 */
var setAWSCredentials = function(assumeRoleParams_) {
  var assumeRoleParams  = assumeRoleParams_ || {};
  var arn               = assumeRoleParams.RoleArn;

  if (arn) {
    jsaws.AWS.cachedCredentials[arn] = jsaws.AWS.cachedCredentials[arn] || new AWS.TemporaryCredentials(assumeRoleParams);
    AWS.config.credentials = jsaws.AWS.cachedCredentials[arn];
    return arn;
  }

  /* otherwise */
  AWS.config.credentials = masterCredentials;
  return 'main';
};

/**
 *
 */
jsaws.getAwsEc2 = function(options_) {

  var options           = options_ || {};
  var serviceParams     = _.pick(options, 'region');
  var assumeRoleParams  = _.pick(options, 'RoleArn', 'RoleSessionName');

  var name              = setAWSCredentials(assumeRoleParams);

  if (!jsaws.AWS.cachedAwsServices[name].ec2) {
    jsaws.AWS.cachedAwsServices[name].ec2 = new AWS.EC2(serviceParams);
  }

  return jsaws.AWS.cachedAwsServices[name].ec2;
};

/**
 *  Get the AWS EC2 object for this acct, and a 'foreign' one.
 */
jsaws.get2Ec2 = function(options_) {
  var options       = options_ || {};
  var aws           = jsaws.configAws(options);

  if (!cachedAwsServices.ec2) {
    cachedAwsServices.ec2 = new aws.EC2({region: options.region});
  }

  return {service: cachedAwsServices.ec2};
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
 *  Get the AWS SNS object.
 */
jsaws.getSns = function(options_) {
  var options       = options_ || {};
  var aws           = jsaws.configAws(options);

  if (!cachedAwsServices.sns) {
    cachedAwsServices.sns = new aws.SNS({region: options.region});
  }

  return cachedAwsServices.sns;
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
 *  Get the AWS Route53 object.
 */
jsaws.getRoute53 = function(options_) {
  var options       = options_ || {};
  var aws           = jsaws.configAws(options);

  if (!cachedAwsServices.route53) {
    cachedAwsServices.route53 = new aws.Route53({region: options.region});
  }

  return cachedAwsServices.route53;
};

/**
 *  Get the AWS Route53 object for this acct, and a 'foreign' one..
 */
jsaws.get2Route53 = function(options) {
  return {service: jsaws.getRoute53(options)};
};

/**
 *  Get the AWS S3 object.
 */
jsaws.getS3 = function(options_) {
  var options       = options_ || {};
  var aws           = jsaws.configAws(options);

  if (!cachedAwsServices.s3) {
    cachedAwsServices.s3 = new aws.S3({region: options.region});
  }

  return cachedAwsServices.s3;
};

/**
 *  Get the AWS S3 object for this acct, and a 'foreign' one..
 */
jsaws.get2S3 = function(options) {
  return {service: jsaws.getS3(options)};
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

  // TODO: Handle code: 'RequestLimitExceeded' (See bottom of this file) -- Needs to be an until
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

  var result;
  return sg.until({}, function(again, last) {
    return awsEc2[awsFnName](argv || {}, function(err, x) {
      if (err) {
        if (err.code === 'RequestLimitExceeded')    { return again(250); }

        /* otherwise */
        return die(err, callback, 'getX2.awsEc2.'+awsFnName);
      }

      result = awsJsonLib.awsToJsObject(x);
      result = result[awsName] || result;

      return last();
    });
  }, function(err) {
    return callback(err, result);
  });
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
var get2All = jsaws.get2All = function(argv, context, callback, awsName, awsFnName) {
  return get2X2_2(argv, context, function(err, the2) {
    if (err)  { return callback(err); }

    return callback(null, _.extend({}, the2.x, the2.foreignX));
  }, awsName, awsFnName);
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
var get2X2_2 = jsaws.get2X2_2 = function(argv, context, callback, awsName /*, awsFnName*/) {
  var args          = _.rest(arguments, 4);
  var awsFnName     = args.pop();

  if (!awsFnName) {
    awsFnName = 'describe'+awsName;
  }

  argv              = jsaws.prep(argv);
  var aws2Ec2       = jsaws.get2Ec2(argv);
  var awsEc2        = aws2Ec2.service;

  delete argv.region;

  var x, foreignX;
  return sg.__runll([function(next) {
    return sg.until({}, function(again, last) {
      return awsEc2[awsFnName](argv || {}, function(err, x_) {
        if (err) {
          if (err.code === 'RequestLimitExceeded')    { return again(250); }

          /* otherwise */
          return die(err, callback, 'get2X2_2.awsEc2.'+awsFnName);
        }

        x = awsJsonLib.awsToJsObject(x_);
        x = x[awsName] || x;

        return last();
      });
    }, next);

  }, function(next) {
    return sg.until({}, function(again, last) {
      return last();
//      return awsForeignEc2(awsFnName, argv || {}, function(err, foreignX_) {
//        if (err) {
//          if (err.code === 'RequestLimitExceeded')    { return again(250); }
//
//          /* otherwise */
//          return die(err, callback, 'get2X2_2.awsEc2.foreign.'+awsFnName);
//        }
//
//        foreignX = awsJsonLib.awsToJsObject(foreignX_);
//        foreignX = foreignX[awsName] || foreignX;
//
//        return last();
//      });
    }, next);
  }], function() {
    return callback(null, {x:x, foreignX:foreignX});
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
var get2X2 = jsaws.get2X2 = function(argv, context, callback, awsName, awsFnName) {
  return get2X2_2(argv, context, function(err, the2) {
    if (err)  { return callback(err); }

    return callback(null, _.extend({}, the2.x, the2.foreignX));
  }, awsName, awsFnName);
};

jsaws.makeEachFn = function(getAllFn) {
  return function(argv, context, eachFn, callback) {
    return getAllFn(argv, context, function(err, allItems) {
      if (err) { return die(err, callback, 'jsaws.eachFn'); }

      _.each(allItems, eachFn);
      return callback();
    });
  };
};

jsaws.makeFilterFn = function(getAllFn) {
  var eachFn = jsaws.makeEachFn(getAllFn);
  return function(argv, context, filterFn, callback) {
    var filteredItems = {};
    return eachFn(argv, context, function(value, key) {
      if (filterFn.apply(this, arguments)) {
        filteredItems[key] = value;
      }
    }, function() {
      return callback(null, filteredItems);
    });
  };
};

///**
// *
// */
//jsaws.getAllResources = function() {
//  var libNames = ['ec2/vpc.js', 'sns/sns.js'];
//  var enums_ = {}, enums = {};
//
//  _.each(libNames, function(libName) {
//    var lib       = require(libName);
//    var libEnums  = lib.awsEnumerators();
//    _.extend(enums, libEnums.all);
//  });
//
//  // Put them in order
//};

// ---------------------------------------------------------------------------------------------------------------------------------------
//    END -- the old, complex way to get info from 2 or 3 accounts.
// ---------------------------------------------------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------------------------------------------------

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

  // "namespace-stack"
  var m = /^([^-]+)-([^-]+)/.exec(deref(vpc, 'Tags.aws.cloudformation.stackName'));
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
  if (+octets[3] < 180)    { return 'netapp'; }    // app
  if (+octets[3] < 200)    { return 'netapp'; }    // app2
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
  if (+octets[3] < 180)    { return 'app'; }    // app
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
  if (+octets[3] < 180)    { return 'app'; }    // app
  if (+octets[3] < 200)    { return 'xapp'; }   // app2
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
};

// Export the jsaws library object
sg.exportify(module, jsaws);

exports.lib2 = {};
_.each(require('../lib2/ec2/ec2.js'), function(value, key) {
  exports.lib2[key] = value;
});

// Export our AWS object wrappers
sg.exportify(module, require('./ec2/ec2.js'));
sg.exportify(module, require('./s3/s3.js'));
sg.exportify(module, require('./ec2/vpc.js'));
sg.exportify(module, require('./ec2/cf.js'));
sg.exportify(module, require('./iam/iam.js'));
sg.exportify(module, require('./sns/sns.js'));
sg.exportify(module, require('./route-53/route-53.js'));

//{ [RequestLimitExceeded: Request limit exceeded.]
//  message: 'Request limit exceeded.',
//  code: 'RequestLimitExceeded',
//  time: Sat Oct 22 2016 13:04:15 GMT+0000 (UTC),
//  requestId: '1d007067-bc8e-45dc-9518-4dbcaf8d7e72',
//  statusCode: 503,
//  retryable: true }
