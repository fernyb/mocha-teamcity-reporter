/* eslint-disable complexity */
/**
 * Teamcity doc reference https://confluence.jetbrains.com/display/TCD10/Build+Script+Interaction+with+TeamCity
 *
 * Module dependencies.
 */
'use strict';

const processPID = process.pid.toString();
const TEST_IGNORED = `##teamcity[testIgnored name='%s' message='%s' flowId='%s']`;
const SUITE_START = `##teamcity[testSuiteStarted name='%s' flowId='%s']`;
const SUITE_END = `##teamcity[testSuiteFinished name='%s' duration='%s' flowId='%s']`;
const SUITE_END_NO_DURATION = `##teamcity[testSuiteFinished name='%s' flowId='%s']`;
const TEST_START = `##teamcity[testStarted name='%s' captureStandardOutput='true' flowId='%s']`;
const TEST_FAILED = `##teamcity[testFailed name='%s' message='%s' details='%s' captureStandardOutput='true' flowId='%s']`;
const TEST_FAILED_COMPARISON = `##teamcity[testFailed type='comparisonFailure' name='%s' message='%s' \
details='%s' captureStandardOutput='true' actual='%s' expected='%s' flowId='%s']`;
const TEST_END = `##teamcity[testFinished name='%s' duration='%s' flowId='%s']`;
const TEST_END_NO_DURATION = `##teamcity[testFinished name='%s' flowId='%s']`;

const Mocha = require('mocha');
const {
	EVENT_SUITE_BEGIN,
	EVENT_TEST_BEGIN,
	EVENT_TEST_FAIL,
	EVENT_TEST_PENDING,
	EVENT_TEST_END,
	EVENT_HOOK_BEGIN,
	EVENT_HOOK_END,
	EVENT_SUITE_END,
	EVENT_RUN_END
  } = Mocha.Runner.constants;

const util = require('util');

let Base, log, logError;

Base = require('mocha').reporters.Base;
log = console.log;
logError = console.error;

/**
 * Escape the given `str`.
 */

function escape(str) {
	if (!str) return '';
	return str
		.toString()
		.replace(/\x1B.*?m/g, '') // eslint-disable-line no-control-regex
		.replace(/\|/g, '||')
		.replace(/\n/g, '|n')
		.replace(/\r/g, '|r')
		.replace(/\[/g, '|[')
		.replace(/\]/g, '|]')
		.replace(/\u0085/g, '|x')
		.replace(/\u2028/g, '|l')
		.replace(/\u2029/g, '|p')
		.replace(/'/g, '|\'');
}

function isNil(value) {
	return value == null; 	// eslint-disable-line
}

function formatString() {
	let formattedArguments = [];
	const args = Array.prototype.slice.call(arguments, 0);
	// Format all arguments for TC display (it escapes using the pipe char).
	let tcMessage = args.shift();
	args.forEach((param) => {
		formattedArguments.push(escape(param));
	});
	formattedArguments.unshift(tcMessage);
	return util.format.apply(util, formattedArguments);
}


/**
 * Initialize a new `Teamcity` reporter.
 *
 * @param {Runner} runner
 * @param {options} options
 * @api public
 */

function Teamcity(runner, options) {
	options = options || {};
	const reporterOptions = options.reporterOptions || {};

	let flowId, useStdError, recordHookFailures, actualVsExpected, ignoreHookWithName, displayIgnoredAsIgnored, displayFailedHookAsFailedTest;
	(reporterOptions.flowId) ? flowId = reporterOptions.flowId : flowId = process.env['MOCHA_TEAMCITY_FLOWID'] || processPID;
	(reporterOptions.useStdError) ? useStdError = reporterOptions.useStdError : useStdError = process.env['USE_STD_ERROR'];
	(reporterOptions.recordHookFailures) ? recordHookFailures = reporterOptions.recordHookFailures : recordHookFailures = process.env['RECORD_HOOK_FAILURES'];
	(reporterOptions.actualVsExpected) ? actualVsExpected = reporterOptions.actualVsExpected : actualVsExpected = process.env['ACTUAL_VS_EXPECTED'];
	(reporterOptions.ignoreHookWithName) ? ignoreHookWithName = reporterOptions.ignoreHookWithName : ignoreHookWithName = process.env['IGNORE_HOOK_WITH_NAME'];

	if (reporterOptions.displayIgnoredAsIgnored) {
		displayIgnoredAsIgnored = reporterOptions.displayIgnoredAsIgnored;
	} else {
		displayIgnoredAsIgnored = process.env['DISPLAY_IGNORED_AS_IGNORED'] || '';
	}
	displayIgnoredAsIgnored = (displayIgnoredAsIgnored.toLowerCase() === 'true');

	if (reporterOptions.displayFailedHookAsFailedTest) {
		displayFailedHookAsFailedTest = reporterOptions.displayFailedHookAsFailedTest;
	} else {
		displayFailedHookAsFailedTest = process.env['DISPLAY_FAILED_HOOK_AS_FAILED_TEST'] || '';
	}
	displayFailedHookAsFailedTest = (displayFailedHookAsFailedTest.toLowerCase() === 'true');

	(useStdError) ? useStdError = (useStdError.toLowerCase() === 'true') : useStdError = false;
	(recordHookFailures) ? recordHookFailures = (recordHookFailures.toLowerCase() === 'true') : recordHookFailures = false;


	(ignoreHookWithName) ? ignoreHookWithName : null;
	actualVsExpected ? actualVsExpected = (actualVsExpected.toLowerCase() === 'true') : actualVsExpected = false;
	Base.call(this, runner);
	let stats = this.stats;
	const topLevelSuite = reporterOptions.topLevelSuite || process.env['MOCHA_TEAMCITY_TOP_LEVEL_SUITE'];

	const hookFlowId = displayFailedHookAsFailedTest ? flowId : `${flowId}_hook`;

	const ignoredTests = {};
	const testState = { pending: 0 };
	const allTestSuites = [];

	const addToSuite = (suite, message) => {
		allTestSuites.push({ suite: message, tests: [] });
	};

	const isHookTest = (test) => {
		let isHook = false;
		if (test.title.includes(`"before all" hook`) ||
			test.title.includes(`"before each" hook`) ||
			test.title.includes(`"after all" hook`) ||
			test.title.includes(`"after each" hook`)
		) {
			isHook = true;
		}
		return isHook;
	};

	const hookNameFromFailedMessage = (failedMessage) => {
		const matches = failedMessage.match(/testFailed name='([\W\w\s@"']+)' message.*flowId='([\w\s"']+)'/);
		const matchName = matches[1];
		const matchFlowId = matches[2];
		const testNameMatches = matches[1].match(/hook for "(.*)"' message|for "(.*)"$/);
		const testName = testNameMatches[1] || testNameMatches[2];
		return {
			matchName,
			matchFlowId,
			testName
		};
	};

	const addToTest = (test, message) => {
		const isHook = isHookTest(test);
		const suite = allTestSuites[allTestSuites.length - 1];

		if (isHook) {
			if (displayFailedHookAsFailedTest) {
				if (/testFailed/.test(message)) {
					const { matchName, matchFlowId, testName } = hookNameFromFailedMessage(message);
					if (/before/.test(matchName)) {
						// remove testStarted tag as it didn't run because it failed in a before hook.
						suite.tests.pop();

						// display test as failed
						// display hook as failed
						if (displayFailedHookAsFailedTest) {
							suite.tests.push(formatString(TEST_START, testName, matchFlowId));
							suite.tests.push(formatString(TEST_FAILED, testName, matchName, 'Failed because there is a hook failure. Resolve the hook failure first.', matchFlowId));
							suite.tests.push(formatString(TEST_END_NO_DURATION, testName, matchFlowId));
						} else {
							suite.tests.push(formatString(TEST_IGNORED, testName, testName, matchFlowId));
						}

						suite.tests.push(formatString(TEST_START, matchName, matchFlowId));
						suite.tests.push(message);
						suite.tests.push(formatString(TEST_END_NO_DURATION, matchName, matchFlowId));

						// suite.tests.push(testStartedMessage);
					}
					else if (/after/.test(matchName)) {
						// display after hooks as failed tests
						suite.tests.push(formatString(TEST_START, matchName, matchFlowId));
						suite.tests.push(message);
						suite.tests.push(formatString(TEST_END_NO_DURATION, matchName, matchFlowId));
					}
				}
			} else {
				suite.tests.push(message);
			}
		}
		else {
			suite.tests.push(message);
		}
	};

	runner.on(EVENT_SUITE_BEGIN, function (suite) {
		if (suite.root) {
			if (topLevelSuite) {
				log(formatString(SUITE_START, topLevelSuite, flowId));
			}
			return;
		}
		suite.startDate = new Date();
		addToSuite(suite, formatString(SUITE_START, suite.title, flowId));
	});

	runner.on(EVENT_TEST_BEGIN, function (test) {
		if (displayIgnoredAsIgnored && ignoredTests[`${test.title}-${flowId}`] === testState.pending) {
			return;
		}
		addToTest(test, formatString(TEST_START, test.title, flowId));
	});

	runner.on(EVENT_TEST_FAIL, function (test, err) {
		const isHook = isHookTest(test);
		const testFlowId = (isHook) ? hookFlowId : flowId;
		if(actualVsExpected && (err.actual && err.expected)){
			if (useStdError) {
				addToTest(test, formatString(TEST_FAILED_COMPARISON, test.title, err.message, err.stack, err.actual, err.expected, testFlowId));
			} else {
				addToTest(test, formatString(TEST_FAILED_COMPARISON, test.title, err.message, err.stack, err.actual, err.expected, testFlowId));
			}
		} else{
			if (useStdError) {
				addToTest(test, formatString(TEST_FAILED, test.title, err.message, err.stack, testFlowId));
			} else {
				addToTest(test, formatString(TEST_FAILED, test.title, err.message, err.stack, testFlowId));
			}
		}
		// Log testFinished for failed hook (hook end event is not fired for failed hook)
		if (recordHookFailures && !ignoreHookWithName || recordHookFailures && ignoreHookWithName && !test.title.includes(ignoreHookWithName)) {
			if (isHook) {
				if(isNil(test.duration)){
					addToTest(test, formatString(TEST_END_NO_DURATION, test.title, hookFlowId));
				} else {
					addToTest(test, formatString(TEST_END, test.title, test.duration.toString(), hookFlowId));
				}
			}
		}
	});

	runner.on(EVENT_TEST_PENDING, function (test) {
		addToTest(test, formatString(TEST_IGNORED, test.title, test.title, flowId));
		if (displayIgnoredAsIgnored) ignoredTests[`${test.title}-${flowId}`] = testState.pending;
	});

	runner.on(EVENT_TEST_END, function (test) {
		if (displayIgnoredAsIgnored && ignoredTests[`${test.title}-${flowId}`] === testState.pending) {
			delete ignoredTests[`${test.title}-${flowId}`];
			return;
		}

		if(isNil(test.duration)){
			addToTest(test, formatString(TEST_END_NO_DURATION, test.title, flowId));
		} else {
			addToTest(test, formatString(TEST_END, test.title, test.duration.toString(), flowId));
		}
	});

	runner.on(EVENT_HOOK_BEGIN, function (test) {
		if (recordHookFailures && !ignoreHookWithName || recordHookFailures && ignoreHookWithName && !test.title.includes(ignoreHookWithName)) {
			addToTest(test, formatString(TEST_START, test.title, hookFlowId));
		}
	});

	runner.on(EVENT_HOOK_END, function (test) {
		if (recordHookFailures && !ignoreHookWithName || recordHookFailures && ignoreHookWithName && !test.title.includes(ignoreHookWithName)) {
			if(isNil(test.duration)){
				addToTest(test, formatString(TEST_END_NO_DURATION, test.title, hookFlowId));
			} else {
				addToTest(test, formatString(TEST_END, test.title, test.duration.toString(), hookFlowId));
			}
		}
	});

	runner.on(EVENT_SUITE_END, function (suite) {
		if (suite.root) return;
		const suiteLast = allTestSuites[allTestSuites.length - 1];
		suiteLast.tests.push(formatString(SUITE_END, suite.title, new Date() - suite.startDate, flowId));
	});

	runner.on(EVENT_RUN_END, function () {
		allTestSuites.forEach((suite) => {
			log(suite.suite);
			suite.tests.forEach((tcMessage) => {
				if (useStdError && /testFailed/.test(tcMessage)) {
					logError(tcMessage);
				} else {
					log(tcMessage);
				}
			});
		});

		let duration;
		(typeof stats === 'undefined') ? duration = null : duration = stats.duration;
		if (topLevelSuite) {
			isNil(duration) ? log(formatString(SUITE_END_NO_DURATION, topLevelSuite, flowId)) : log(formatString(SUITE_END, topLevelSuite, duration, flowId));
		}
});
}


/**
 * Expose `Teamcity`.
 */

exports = module.exports = Teamcity;
