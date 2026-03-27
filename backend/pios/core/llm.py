"""LiteLLM wrapper for unified LLM interface."""

import logging
from typing import Optional, Dict, Any, List, Tuple

logger = logging.getLogger(__name__)


class LLMClient:
    """Wrapper around LiteLLM for unified LLM access."""

    def __init__(
        self,
        provider: str = "openai",
        model: str = "gpt-4",
        api_key: str = "",
        base_url: Optional[str] = None,
        temperature: float = 0.7,
        max_tokens: int = 2000,
        fallback_models: Optional[List[str]] = None,
    ):
        """Initialize LLM client.

        Args:
            provider: LLM provider (openai, anthropic, etc.)
            model: Model identifier
            api_key: API key for the provider
            base_url: Optional custom base URL
            temperature: Sampling temperature
            max_tokens: Maximum tokens to generate
            fallback_models: Ordered list of fallback model names (litellm format) if primary fails
        """
        self.provider = provider
        self.model = model
        self.api_key = api_key
        self.base_url = base_url
        self.temperature = temperature
        self.max_tokens = max_tokens
        self.fallback_models: List[str] = fallback_models or []

        # Token usage tracking
        self.total_prompt_tokens: int = 0
        self.total_completion_tokens: int = 0
        self.total_calls: int = 0

        # Import litellm only when needed
        try:
            import litellm
            self.litellm = litellm
            if api_key:
                if provider == "openai":
                    self.litellm.api_key = api_key
                elif provider == "anthropic":
                    self.litellm.api_key = api_key
        except ImportError:
            logger.warning("litellm not installed, LLM features will be limited")
            self.litellm = None

    def complete(
        self,
        messages: List[Dict[str, str]],
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        **kwargs,
    ) -> str:
        """Generate a completion.

        Args:
            messages: List of message dicts with 'role' and 'content'
            temperature: Override default temperature
            max_tokens: Override default max_tokens
            **kwargs: Additional arguments to pass to the model

        Returns:
            Generated text
        """
        if not self.litellm:
            logger.error("LiteLLM not available")
            return ""

        temp = temperature if temperature is not None else self.temperature
        tokens = max_tokens if max_tokens is not None else self.max_tokens

        primary_model = self._resolve_model_name(self.provider, self.model)
        models_to_try = [primary_model] + self.fallback_models
        last_error: Optional[Exception] = None

        for model_name in models_to_try:
            try:
                response = self.litellm.completion(
                    model=model_name,
                    messages=messages,
                    temperature=temp,
                    max_tokens=tokens,
                    **kwargs,
                )
                # Track token usage
                self.total_calls += 1
                usage = getattr(response, "usage", None)
                if usage:
                    self.total_prompt_tokens += getattr(usage, "prompt_tokens", 0) or 0
                    self.total_completion_tokens += getattr(usage, "completion_tokens", 0) or 0

                if model_name != primary_model:
                    logger.info(f"Used fallback model {model_name} (primary {primary_model} failed)")
                return response.choices[0].message.content
            except Exception as e:
                last_error = e
                logger.warning(f"Model {model_name} failed: {e}")
                continue

        logger.error(f"All models failed. Last error: {last_error}")
        raise last_error

    @staticmethod
    def _resolve_model_name(provider: str, model: str) -> str:
        """Resolve provider+model to a litellm model string."""
        if provider == "openai":
            return model
        if provider == "anthropic":
            return f"claude-{model}" if not model.startswith("claude") else model
        return f"{provider}/{model}"

    def extract_json(
        self,
        prompt: str,
        temperature: Optional[float] = None,
        **kwargs,
    ) -> Dict[str, Any]:
        """Extract JSON from a prompt.

        Args:
            prompt: The prompt to send
            temperature: Override default temperature
            **kwargs: Additional arguments

        Returns:
            Parsed JSON response
        """
        import json

        messages = [{"role": "user", "content": prompt}]
        response = self.complete(messages, temperature=temperature, **kwargs)

        try:
            return json.loads(response)
        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse JSON response: {e}")
            # Try to extract JSON from response
            import re
            json_match = re.search(r"\{.*\}", response, re.DOTALL)
            if json_match:
                try:
                    return json.loads(json_match.group())
                except json.JSONDecodeError:
                    pass
            raise

    def summarize(self, text: str, max_length: int = 500) -> str:
        """Summarize text.

        Args:
            text: Text to summarize
            max_length: Maximum length of summary

        Returns:
            Summarized text
        """
        prompt = f"Summarize the following text in at most {max_length} words:\n\n{text}"
        messages = [{"role": "user", "content": prompt}]
        return self.complete(messages)

    def classify(self, text: str, categories: List[str]) -> str:
        """Classify text into one of the provided categories.

        Args:
            text: Text to classify
            categories: List of possible categories

        Returns:
            Selected category
        """
        categories_str = ", ".join(categories)
        prompt = (
            f"Classify the following text as one of these categories: {categories_str}\n\n"
            f"Text: {text}\n\n"
            f"Category: "
        )
        messages = [{"role": "user", "content": prompt}]
        response = self.complete(messages, temperature=0.1)
        return response.strip()

    def is_available(self) -> bool:
        """Check if LLM is available.

        Returns:
            True if LLM can be used
        """
        return self.litellm is not None and self.api_key != ""

    def get_usage(self) -> Dict[str, Any]:
        """Return cumulative token usage stats.

        Returns:
            Dictionary with prompt_tokens, completion_tokens, total_tokens, and calls
        """
        return {
            "prompt_tokens": self.total_prompt_tokens,
            "completion_tokens": self.total_completion_tokens,
            "total_tokens": self.total_prompt_tokens + self.total_completion_tokens,
            "calls": self.total_calls,
        }

    def reset_usage(self) -> None:
        """Reset token usage counters."""
        self.total_prompt_tokens = 0
        self.total_completion_tokens = 0
        self.total_calls = 0
