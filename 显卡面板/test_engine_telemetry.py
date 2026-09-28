import importlib.util
import pathlib
import unittest
from unittest import mock


SOURCE = pathlib.Path(__file__).with_name("gpu_panel_unified.py")
spec = importlib.util.spec_from_file_location("panel_under_test", SOURCE)
panel = importlib.util.module_from_spec(spec)
spec.loader.exec_module(panel)


class EngineTelemetryTests(unittest.TestCase):
    def test_identifies_engines_by_native_evidence(self):
        self.assertEqual(panel._classify_engine(
            {"data": [{"id": "a", "owned_by": "vllm"}]}, ""), "vllm")
        self.assertEqual(panel._classify_engine(
            {"data": [{"id": "a", "owned_by": "fastllm"}]}, ""), "fastllm")
        self.assertEqual(panel._classify_engine(
            {"data": [{"id": "a"}]}, ""), "openai")

    def test_vllm_native_snapshot_reports_running_waiting_and_kv(self):
        metrics = '''vllm:num_requests_running{engine="0"} 2
vllm:num_requests_waiting{engine="0"} 1
vllm:kv_cache_usage_perc{engine="0"} 0.375
vllm:generation_tokens_total{engine="0"} 100
'''
        sampler = panel.LlamaCppSampler("http://localhost:8000")
        sampler._model = "qwen"
        sampler._context_limit = 163840
        with mock.patch.object(sampler, "_get_metrics", return_value=metrics):
            with mock.patch.object(panel, "LLM_KIND", "vllm"):
                result = sampler.sample()
        self.assertEqual(result["kind"], "vllm")
        self.assertEqual(result["running"], 2)
        self.assertEqual(result["waiting"], 1)
        self.assertEqual(result["kv_cache_pct"], 37.5)
        self.assertEqual(result["context_limit"], 163840)
        self.assertEqual(result["telemetry_source"], "engine")

    def test_first_openai_sample_never_generates_a_probe(self):
        with mock.patch.object(panel, "LLM_PROBE_INTERVAL", 60):
            sampler = panel.LlamaCppSampler("http://localhost:8000")
            with mock.patch.object(sampler, "_post_chat", return_value={"usage": {"completion_tokens": 2}}) as probe:
                with mock.patch.object(panel, "LLM_KIND", "openai"):
                    self.assertTrue(sampler.sample()["online"])
            probe.assert_not_called()

    def test_proxy_exposes_active_request_metadata_without_prompt_body(self):
        ledger = panel._ProxyStats()
        request = ledger.begin()
        ledger.describe(request, "/v1/chat/completions", b'{"model":"qwen","max_tokens":128,"messages":[{"content":"secret"}]}')
        active = ledger.snapshot()["active_requests"]
        self.assertEqual(len(active), 1)
        self.assertEqual(active[0]["model"], "qwen")
        self.assertEqual(active[0]["max_tokens"], 128)
        self.assertNotIn("secret", str(active))

    def test_llamacpp_keeps_exact_slot_context(self):
        sampler = panel.LlamaCppSampler("http://localhost:8000")
        slot = {"id": 0, "id_task": 3, "n_ctx": 8192,
                "n_prompt_tokens": 2048, "n_prompt_tokens_processed": 2048,
                "is_processing": True,
                "next_token": [{"n_decoded": 40, "n_remain": 10}]}
        with mock.patch.object(panel, "LLM_KIND", "llamacpp"):
            with mock.patch.object(sampler, "_get", return_value=[slot]):
                result = sampler.sample()
        self.assertEqual(result["busy"], 1)
        self.assertEqual(result["slots"][0]["ctx_used"], 2048)
        self.assertEqual(result["slots"][0]["ctx"], 8192)

    def test_fastllm_dev_count_is_native_when_available(self):
        sampler = panel.LlamaCppSampler("http://localhost:8000")
        with mock.patch.object(panel, "LLM_KIND", "fastllm"):
            with mock.patch.object(sampler, "_get", return_value={"count": 2, "active_conversations": []}):
                result = sampler.sample()
        self.assertEqual(result["running"], 2)
        self.assertEqual(result["telemetry_source"], "engine")


if __name__ == "__main__":
    unittest.main()
