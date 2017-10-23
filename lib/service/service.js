
/**
 *
 */

var sg                  = require('sgsg');
var _                   = sg._;
var awsJsonLib          = sg.include('aws-json')      || require('aws-json');
var AWS                 = require('aws-sdk');

var die                 = sg.die;
var argvGet             = sg.argvGet;
var argvExtract         = sg.argvExtract;

// Caches
var credsForRole        = {};
var services            = {};

// The credentials that this instance has normally
credsForRole.main       = new AWS.EC2MetadataCredentials({});
AWS.config.credentials  = credsForRole.main;

var flattenAndLabel;

var lib                 = {};

/**
 *  Returns an AWS service object (like AWS.EC2), when given the ARN (or
 *  at least the acct and role, so we can build the ARN.
 *
 *  @param {string} serviceName     - The AWS service name like EC2.
 *  @param {string} acct            - The foreign AWS account number.
 *  @param {string} role            - The role to assume.
 *  @param {string} roleSessionName - A name for the role, must be unique for all the foreign accts that
 *                                    will be used during this session.
 *
 *                  -- or --
 *
 *  @param {string} serviceName     - The AWS service name, as above.
 *  @param {object} argv            - A run-anywhere style argv object with 'acct', 'role', and 'role-session-name', and 'region'
 *
 *                  -- or --
 *
 *  @param {string} serviceName     - The AWS service name, as above.
 *  @param {string} argv            - A run-anywhere style argv object with 'iam-mini-arn' as the three parts as 'acct/role', and 'region'
 *                                    roleSessionName will then be '{role}_session'
 *                  -- or --
 *
 *  @param {string} serviceName     - The AWS service name, as above.
 *  @param {string} argv            - As immediately above (iam-mini-arn), but argv has 'acct-name', which is looked up on JSAWS_AWS_ACCT_EXTRA_CREDS.
 *
 */
var awsService = lib.awsService = function(serviceName, roleSessionName, acct, role, region_) {
  if (arguments.length === 2) {

    var roleSessionName_, acct_, role_, region_, parts, jsawsAccts;

    var argv              = arguments[1];
    var iamMiniArn        = argvGet(argv, 'iam-mini-arn,iam-arn,iam');
    var acctName          = argvGet(argv, 'acct-name,acct');

    if (acctName) {
      jsawsAccts = sg.parseOn2Chars(process.env.JSAWS_AWS_ACCT_EXTRA_CREDS, ',', ':');
      iamMiniArn = jsawsAccts[acctName] || iamMiniArn;
    }

    if (iamMiniArn) {
      // Ignore the first part (before ':') -- prod:123456789/role-name
      parts               = iamMiniArn.split(':');
      iamMiniArn          = parts[1] || parts[0];

      parts               = iamMiniArn.split('/');
      acct_               = parts[0];
      role_               = parts[1];
      roleSessionName_    = [acct_, role_, 'session'].join('_');
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
 *
 */
lib.eachAwsService = function(serviceName, argv, fn, callback) {
  if (arguments.length === 3) {
    return lib.eachAwsService(serviceName, {}, arguments[1], arguments[2]);
  }

  // Allow putting callback early in the list
  if (_.isFunction(arguments[1])) {
    return lib.eachAwsService(serviceName, arguments[2], arguments[1], arguments[3]);
  }

  const accts               = (argvGet(argv, 'accts') || process.env.JSAWS_AWS_ACCT_EXTRA_CREDS || '').split(',');
  const onlyOneAcct         = argvGet(argv, 'only-one-acct,acct,onlyOneAcct');

  return sg.__eachll(accts, function(acct, nextAcct) {

    // acct is 'prod:123456/proj-iamsomething' or 'dev' (dev is the current acct in this case)
    const [acctName, iam] = acct.split(':');

    // Sometimes you have to force this function only to use one acct (if it isnt onlyOneAcct, skip it)
    if (onlyOneAcct && (onlyOneAcct !== acctName)) {
      return nextAcct();
    }

    // The AWS  'module' (like AWS.EC2) service for the acct
    var awsModule = awsService(awsServiceName, sg.kv('iam', iam));

    return fn(awsModule, nextAcct);
  }, callback);
};

/**
 *  Extracts (removes) the params that are meaningful for the awsService function.
 */
lib.extractServiceArgs = function(argv) {
  return {
    acctName        : argvExtract(argv, 'acct-name') || sg.extract(argv, 'acctName'),
    iam_mini_arn    : argvExtract(argv, 'iam-mini-arn,iam-arn,iam'),
    session         : argvExtract(argv, 'role_session_name,session'),
    account         : argvExtract(argv, 'account,acct'),
    role            : argvExtract(argv, 'role'),
    region          : argvExtract(argv, 'region')
  };
};

/**
 *  The common part of all of the ec2 describeXyz-like APIs (also works for listXyz APIs, if
 *  the caller passes awsFnName.)
 *
 *  This function will take care of all of the multi-account stuff, as well as the until() call
 *  for any of the describe functions.
 */
var describe = lib.describe = lib.list = function(argv_, context, callback) {   /* (argv_, context, awsName, callback, awsFnName_, awsServiceName_) */
  var   argv                = sg.deepCopy(argv_);
  const awsName             = argvExtract(argv, 'type');
  const awsFnName_          = argvExtract(argv, 'fname,f-name');
  const awsServiceName      = argvExtract(argv, 'service')        || 'EC2';
  var   awsFnName           = awsFnName_                          || (awsServiceName === 'EC2' ? 'describe' : 'list')+awsName;
  var   accts               = (sg.extract(argv, 'accts')          || process.env.JSAWS_AWS_ACCT_EXTRA_CREDS || '').split(',');
  var   onlyOneAcct         = sg.extract(argv, 'onlyOneAcct');

  var accountItems = {};
  var accountExtra = {};

  return sg.__eachll(accts, function(acct, nextAcct) {

    // acct is 'prod:123456789012/projc-yournamehere' or 'dev'
    var parts     = acct.split(':');
    var acctName  = parts[0];
    var iam       = parts[1];

    // Sometimes you have to force this function only to use one acct (if it isnt onlyOneAcct, skip it)
    if (onlyOneAcct && (onlyOneAcct !== acctName)) {
      return nextAcct();
    }

    // The AWS  'module' (like AWS.EC2) service for the acct
    var awsModule = awsService(awsServiceName, sg.kv('iam', iam));

    // Return results by acct name
    accountItems[acctName] = {};
    accountExtra[acctName] = {};

    // Run until we get a result
    return sg.until(function(again, last, count) {
      if (count > 12) { return die(err, callback, `service.${awsFnName}.too_many_tries`); }

      // Like ec2.describeInstances(...)
      return awsModule[awsFnName](argv, function(err, items) {
        if (err) {
          if (err.code === 'RequestLimitExceeded')    { return again(250); }

          /* otherwise */
          console.error(argv);
          return die(err, callback, `service.${awsFnName}.fail using ${iam}`);
        }

        // Fixup the AWS-style JSON
        accountItems[acctName] = awsJsonLib.awsToJsObject(items);

        // Usually, when asking for describeFoo(), the result will have a 'Foo' attr, but not always,
        // for example, describeInstances has items.Reservations
        accountExtra[acctName] = _.omit(accountItems[acctName], awsName);
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
    return callback(null, {items:flattenAndLabel(result), accountExtra});
  });
};

/**
 *  Takes the output of the describe() function, and flattens it (one level
 *  with all the items from all the accts), with each item labeled with
 *  `accountName`.
 */
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

_.each(lib, function(value, key) {
  exports[key] = value;
});

