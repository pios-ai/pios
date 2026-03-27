"""LiteLLM wrapper for unified LLM interface."""

import logging
from typing import Optional, Dict, Any, List

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
    ):
        """Initialize LLM client.

        Args:
            provider: LLM provider (openai, anthropic, etc.)
            model: Model identifier
            api_key: API key for the provider
            base_url: Optional custom base URL
            temperature: Sampling temperature
            max_tokens: Maximum tokens to generate
        """
        self.provider = provider
        self.model = model
        self.api_key = api_key
        self.base_url = base_url
        self.temperature = temperature
        self.max_tokens = max_tokens

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

        try:
            model_name = f"{self.provider}/{self.model}"
            if self.provider == "openai":
                model_name = self.model
            elif self.provider == "anthropic":
                model_name = f"claude-{self.model}" if not self.model.startswith("claude") else self.model

            response = self.litellm.completion(
                model=model_name,
                messages=messages,
                temperature=temp,
                max_tokens=tokens,
                **kwargs,
            )

            return response.choices[0].message.content
        except Exception as e:
            logger.error(f"Error calling LLM: {e}")
            raise

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
