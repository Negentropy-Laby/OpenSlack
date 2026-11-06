"""Explicit platform classification and measured discovery/execution summaries."""
import json
import sys
import unittest


class PortableTests(unittest.TestCase):
    cleanup_portability = 'portable'


class LinuxTests(unittest.TestCase):
    cleanup_portability = 'linux'


class RecordedResult(unittest.TextTestResult):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.executed_test_ids = []

    def startTest(self, test):
        self.executed_test_ids.append(test.id())
        super().startTest(test)


def flatten(suite):
    for item in suite:
        if isinstance(item, unittest.TestSuite):
            yield from flatten(item)
        else:
            yield item


def run(module):
    portable = '--portable' in sys.argv
    linux_only = '--linux-only' in sys.argv
    if portable and linux_only:
        raise SystemExit('TEST_SELECTION_CONFLICT')
    if portable:
        sys.argv.remove('--portable')
    if linux_only:
        sys.argv.remove('--linux-only')
        if sys.platform != 'linux':
            raise SystemExit('TEST_LINUX_REQUIRED')
    discovered = list(flatten(unittest.defaultTestLoader.loadTestsFromModule(module)))
    if any(getattr(test, 'cleanup_portability', None) not in ('portable', 'linux') for test in discovered):
        raise SystemExit('TEST_PORTABILITY_UNDECLARED: classify every discovered test')
    portability = {kind: sum(test.cleanup_portability == kind for test in discovered)
                   for kind in ('portable', 'linux')}
    selection = 'portable' if portable else 'linux' if linux_only else 'all'
    selected = [test for test in discovered if selection == 'all' or test.cleanup_portability == selection]
    if len(sys.argv) > 1:
        requested = set(sys.argv[1:])
        def matches(test, name):
            return type(test).__name__ == name or test.id().endswith(name)
        if any(not any(matches(test, name) for test in selected) for name in requested):
            raise SystemExit('TEST_SELECTION_UNKNOWN')
        selected = [test for test in selected if any(matches(test, name) for name in requested)]
    if not selected:
        raise SystemExit('TEST_SELECTION_EMPTY')
    result = unittest.TextTestRunner(verbosity=2, resultclass=RecordedResult).run(unittest.TestSuite(selected))
    print(json.dumps(dict(schema='openslack.cleanup_python_test_run.v1', discovered=len(discovered),
        selected=len(selected), executed=result.testsRun, portableOnly=portable,
        selection=selection, portability=portability,
        inventory={kind: [test.id() for test in discovered if test.cleanup_portability == kind]
                   for kind in ('portable', 'linux')},
        executedTestIds=result.executed_test_ids,
        failures=len(result.failures), errors=len(result.errors), skipped=len(result.skipped),
        successful=result.wasSuccessful()), sort_keys=True))
    raise SystemExit(0 if result.wasSuccessful() and result.testsRun == len(selected) and not result.skipped else 1)
