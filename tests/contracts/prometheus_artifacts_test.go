package contracts_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestPrometheusReliabilityArtifactsAreFixedAndComplete(t *testing.T) {
	root := repositoryRoot(t)
	read := func(parts ...string) string {
		t.Helper()
		data, err := os.ReadFile(filepath.Join(append([]string{root}, parts...)...))
		if err != nil {
			t.Fatal(err)
		}
		return string(data)
	}
	collector := read("internal", "reliability", "service.go")
	for _, metric := range []string{"rc_wsman_outbox_pending", "rc_wsman_oldest_pending_age_seconds", "rc_wsman_dead_notifications"} {
		if strings.Count(collector, metric) != 1 {
			t.Fatalf("collector must declare %s exactly once", metric)
		}
	}
	for _, forbidden := range []string{"vendor_id=", "notification_id=", "caller_id=", "payload=", "credential="} {
		if strings.Contains(collector, forbidden) {
			t.Fatalf("collector contains business label %q", forbidden)
		}
	}
	config := read("deploy", "prometheus", "prometheus.yml")
	for _, fixed := range []string{"scrape_interval: 15s", "scrape_timeout: 5s", "evaluation_interval: 15s", "metrics_path: /metrics"} {
		if !strings.Contains(config, fixed) {
			t.Fatalf("Prometheus config missing %q", fixed)
		}
	}
	alert := read("deploy", "prometheus", "alerts.yml")
	for _, fixed := range []string{"RcWsmanDeadNotifications", "for: 5m", "rc_wsman_dead_notifications > 0", `up{job="rc_wsman"} == 0`, `ALERTS{alertname="RcWsmanDeadNotifications", alertstate="firing"}`} {
		if !strings.Contains(alert, fixed) {
			t.Fatalf("alert rule missing %q", fixed)
		}
	}
	ruleTests := read("deploy", "prometheus", "rules.test.yml")
	for _, scenario := range []string{"dead_fires_after_five_uninterrupted_minutes", "failure_before_firing_resets_pending", "successful_zero_resolves", "failure_after_firing_keeps_firing"} {
		if !strings.Contains(ruleTests, scenario) {
			t.Fatalf("rule unit tests missing %s", scenario)
		}
	}
}

func TestPrometheusRuleUnitTestsEncodeFiringResetHoldAndResolve(t *testing.T) {
	root := repositoryRoot(t)
	data, err := os.ReadFile(filepath.Join(root, "deploy", "prometheus", "rules.test.yml"))
	if err != nil {
		t.Fatal(err)
	}
	var suite struct {
		Tests []struct {
			Name        string `yaml:"name"`
			InputSeries []struct {
				Series string `yaml:"series"`
				Values string `yaml:"values"`
			} `yaml:"input_series"`
			AlertTests []struct {
				EvalTime  string           `yaml:"eval_time"`
				AlertName string           `yaml:"alertname"`
				ExpAlerts []map[string]any `yaml:"exp_alerts"`
			} `yaml:"alert_rule_test"`
		} `yaml:"tests"`
	}
	if err := yaml.Unmarshal(data, &suite); err != nil {
		t.Fatal(err)
	}
	byName := map[string]struct {
		series []string
		evals  map[string]int
	}{}
	for _, scenario := range suite.Tests {
		entry := struct {
			series []string
			evals  map[string]int
		}{evals: map[string]int{}}
		for _, input := range scenario.InputSeries {
			entry.series = append(entry.series, input.Series+"="+input.Values)
		}
		for _, evaluation := range scenario.AlertTests {
			if evaluation.AlertName != "RcWsmanDeadNotifications" {
				t.Fatalf("scenario %s evaluates unexpected alert %q", scenario.Name, evaluation.AlertName)
			}
			entry.evals[evaluation.EvalTime] = len(evaluation.ExpAlerts)
		}
		byName[scenario.Name] = entry
	}
	assertScenario := func(name string, seriesFragments []string, evals map[string]int) {
		t.Helper()
		scenario, ok := byName[name]
		if !ok {
			t.Fatalf("missing scenario %s", name)
		}
		joined := strings.Join(scenario.series, " ")
		for _, fragment := range seriesFragments {
			if !strings.Contains(joined, fragment) {
				t.Fatalf("scenario %s missing input fragment %q: %s", name, fragment, joined)
			}
		}
		for at, expected := range evals {
			if scenario.evals[at] != expected {
				t.Fatalf("scenario %s at %s alerts=%d want=%d", name, at, scenario.evals[at], expected)
			}
		}
	}
	assertScenario("dead_fires_after_five_uninterrupted_minutes", []string{"up{", "1+0x24", "rc_wsman_dead_notifications", "1+0x24"}, map[string]int{"4m45s": 0, "5m": 1})
	assertScenario("failure_before_firing_resets_pending", []string{"0", "_"}, map[string]int{"6m30s": 0})
	assertScenario("failure_after_firing_keeps_firing", []string{"0+0x4", "_x4"}, map[string]int{"5m30s": 1})
	assertScenario("successful_zero_resolves", []string{"1+0x20 0"}, map[string]int{"5m": 1, "5m15s": 0})
}
