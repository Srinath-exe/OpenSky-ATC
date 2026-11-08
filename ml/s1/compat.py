"""This host runs Python 3.11.0rc1, which lacks sys.get_int_max_str_digits / set_int_max_str_digits (added in the
3.11 final release); PyTorch's compiler stack wraps them with matching signatures. Import this module before torch.
It is a no-op on a normal Python."""
import sys

if not hasattr(sys, "get_int_max_str_digits"):
    def get_int_max_str_digits() -> int:
        return 4300

    def set_int_max_str_digits(maxdigits: int) -> None:
        return None

    sys.get_int_max_str_digits = get_int_max_str_digits    # type: ignore[attr-defined]
    sys.set_int_max_str_digits = set_int_max_str_digits    # type: ignore[attr-defined]
