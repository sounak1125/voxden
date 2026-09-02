"""Optional real PEFT/Whisper contract tests on tiny random weights, offline.

These verify training mechanics, NOT speech recognition or large-v3 quality.
Run explicitly after installing training requirements.
"""
import copy
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from finetune import configure_lora, parser
from inference import local_environment


class ModelContractTests(unittest.TestCase):
    def test_cuda_fp16_trainer_accumulation(self):
        local_environment()
        import torch
        from transformers import Seq2SeqTrainer, Seq2SeqTrainingArguments, WhisperConfig, WhisperForConditionalGeneration
        if not torch.cuda.is_available():
            self.skipTest('CUDA hardware required for the FP16 contract test')
        config = WhisperConfig(vocab_size=32, num_mel_bins=4, d_model=16,
            encoder_layers=1, decoder_layers=1, encoder_attention_heads=2, decoder_attention_heads=2,
            encoder_ffn_dim=32, decoder_ffn_dim=32, max_source_positions=8, max_target_positions=12,
            pad_token_id=0, bos_token_id=1, eos_token_id=2, decoder_start_token_id=1,
            suppress_tokens=[], begin_suppress_tokens=[])
        model = configure_lora(WhisperForConditionalGeneration(config).half(),
                               parser().parse_args(['--rank', '2', '--alpha', '4']))
        rows = [{'input_features': torch.randn(4, 16), 'labels': torch.tensor([1, 5, 9, 2])} for _ in range(4)]
        with tempfile.TemporaryDirectory() as folder:
            args = Seq2SeqTrainingArguments(output_dir=folder, max_steps=2, per_device_train_batch_size=1,
                gradient_accumulation_steps=2, fp16=True, gradient_checkpointing=True,
                gradient_checkpointing_kwargs={'use_reentrant': False}, label_names=['labels'],
                report_to=[], save_strategy='no', remove_unused_columns=False, disable_tqdm=True)
            trainer = Seq2SeqTrainer(model=model, args=args, train_dataset=rows,
                data_collator=lambda batch: {key: torch.stack([row[key] for row in batch]) for key in batch[0]})
            result = trainer.train()
            self.assertEqual(result.global_step, 2)
            self.assertTrue(torch.isfinite(torch.tensor(result.training_loss)))
            self.assertTrue(any(p.abs().sum() > 0 for n, p in model.named_parameters() if 'lora_B' in n))

    def test_real_ct2_conversion_and_faster_whisper_generator(self):
        local_environment()
        import numpy as np
        from ctranslate2.converters import TransformersConverter
        from faster_whisper import WhisperModel
        from tokenizers import Tokenizer
        from tokenizers.models import WordLevel
        from transformers import PreTrainedTokenizerFast, WhisperConfig, WhisperFeatureExtractor, WhisperForConditionalGeneration
        from artifacts import validate_ct2
        tokens = ['unknown', 'word', '<|endoftext|>', '<|startoftranscript|>', '<|translate|>', '<|transcribe|>',
                  '<|startoflm|>', '<|startofprev|>', '<|nospeech|>', '<|notimestamps|>']
        tokens += [f'<|{i * .02:.2f}|>' for i in range(51)]
        tokenizer = PreTrainedTokenizerFast(tokenizer_object=Tokenizer(WordLevel({t: i for i, t in enumerate(tokens)}, unk_token='unknown')),
            unk_token='unknown', bos_token='<|startoftranscript|>', eos_token='<|endoftext|>', pad_token='<|endoftext|>')
        config = WhisperConfig(vocab_size=len(tokens), num_mel_bins=4, d_model=16,
            encoder_layers=1, decoder_layers=1, encoder_attention_heads=2, decoder_attention_heads=2,
            encoder_ffn_dim=32, decoder_ffn_dim=32, max_source_positions=1500, max_target_positions=448,
            pad_token_id=2, bos_token_id=3, eos_token_id=2, decoder_start_token_id=3,
            suppress_tokens=[], begin_suppress_tokens=[])
        with tempfile.TemporaryDirectory() as folder:
            hf, ct2 = Path(folder) / 'hf', Path(folder) / 'ct2'
            WhisperForConditionalGeneration(config).save_pretrained(hf, safe_serialization=True)
            tokenizer.save_pretrained(hf)
            WhisperFeatureExtractor(feature_size=4, chunk_length=30).save_pretrained(hf)
            TransformersConverter(str(hf), copy_files=['tokenizer.json', 'preprocessor_config.json']).convert(str(ct2), quantization='float32')
            validate_ct2(ct2)
            model = WhisperModel(str(ct2), device='cpu', compute_type='float32', local_files_only=True)
            segments, info = model.transcribe(np.zeros(8000, dtype=np.float32), language='en',
                vad_filter=False, beam_size=1, temperature=0, without_timestamps=True, max_new_tokens=2,
                suppress_tokens=[], suppress_blank=False, no_speech_threshold=None)
            list(segments)  # Inference is lazy: loading the model alone is not a test.
            self.assertEqual(info.duration, .5)

    def test_lora_checkpointed_gradients_adapter_reload_and_merge(self):
        local_environment()
        import torch
        from peft import PeftModel
        from transformers import WhisperConfig, WhisperForConditionalGeneration
        torch.manual_seed(17)
        config = WhisperConfig(vocab_size=32, num_mel_bins=4, d_model=16,
            encoder_layers=1, decoder_layers=1, encoder_attention_heads=2, decoder_attention_heads=2,
            encoder_ffn_dim=32, decoder_ffn_dim=32, max_source_positions=8, max_target_positions=12,
            pad_token_id=0, bos_token_id=1, eos_token_id=2, decoder_start_token_id=1,
            suppress_tokens=[], begin_suppress_tokens=[])
        base = WhisperForConditionalGeneration(config)
        original = copy.deepcopy(base.state_dict())
        args = parser().parse_args(['--rank', '2', '--alpha', '4', '--dropout', '0'])
        model = configure_lora(base, args)
        model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={'use_reentrant': False})
        model.train()
        features = torch.randn(1, 4, 16)
        labels = torch.tensor([[1, 5, 9, 2]])
        optimizer = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=.01)
        loss = model(input_features=features, labels=labels).loss
        self.assertTrue(torch.isfinite(loss))
        loss.backward()
        for side in ('encoder', 'decoder'):
            grads = [p.grad for n, p in model.named_parameters() if side in n and 'lora_B' in n]
            self.assertTrue(grads and any(g is not None and g.abs().sum() > 0 for g in grads), side)
        self.assertTrue(all(p.grad is None for p in model.parameters() if not p.requires_grad))
        optimizer.step()
        model.eval()
        expected = model(input_features=features, labels=labels).logits.detach()
        with tempfile.TemporaryDirectory() as folder:
            model.save_pretrained(folder, safe_serialization=True)
            self.assertTrue((Path(folder) / 'adapter_model.safetensors').exists())
            fresh = WhisperForConditionalGeneration(config)
            fresh.load_state_dict(original)
            restored = PeftModel.from_pretrained(fresh, folder, local_files_only=True)
            restored.eval()
            actual = restored(input_features=features, labels=labels).logits.detach()
            torch.testing.assert_close(expected, actual)
            merged = restored.merge_and_unload(safe_merge=True)
            merged.eval()
            torch.testing.assert_close(expected, merged(input_features=features, labels=labels).logits.detach(), atol=1e-5, rtol=1e-4)
            self.assertFalse(any('lora_' in n for n, _ in merged.named_parameters()))


if __name__ == '__main__':
    unittest.main()
