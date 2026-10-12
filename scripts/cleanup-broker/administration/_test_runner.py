"""Explicit platform classification and measured discovery/execution summaries."""
import json
import sys
import unittest


class PortableTests(unittest.TestCase):
    cleanup_portability = 'portable'


class LinuxTests(unittest.TestCase):
    cleanup_portability = 'linux'


def flatten(suite):
    for item in suite:
        if isinstance(item, unittest.TestSuite):
            yield from flatten(item)
        else:
            yield item


def run(module):
    portable = '--portable' in sys.argv
    if portable:
        sys.argv.remove('--portable')
    discovered = list(flatten(unittest.defaultTestLoader.loadTestsFromModule(module)))
    if any(getattr(test, 'cleanup_portability', None) not in ('portable', 'linux') for test in discovered):
        raise SystemExit('TEST_PORTABILITY_UNDECLARED: classify every discovered test')
    selected = [test for test in discovered if not portable or test.cleanup_portability == 'portable']
    if len(sys.argv) > 1:
        requested = set(sys.argv[1:])
        selected = [test for test in selected if any(test.id().endswith(name) for name in requested)]
        if not selected:
            raise SystemExit('TEST_SELECTION_EMPTY')
    result = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(selected))
    print(json.dumps(dict(schema='openslack.cleanup_python_test_run.v1', discovered=len(discovered),
        selected=len(selected), executed=result.testsRun, portableOnly=portable,
        failures=len(result.failures), errors=len(result.errors), skipped=len(result.skipped),
        successful=result.wasSuccessful()), sort_keys=True))
    raise SystemExit(0 if result.wasSuccessful() and result.testsRun == len(selected) and not result.skipped else 1)
