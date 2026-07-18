"""
Shared field-validation helpers used across route modules.
"""


def validate_pigeon_name(name: str) -> str:
    """Strip whitespace and enforce pigeon name constraints: 1-30 printable characters."""
    stripped = name.strip()
    if not stripped:
        raise ValueError("Pigeon name cannot be empty")
    if len(stripped) > 30:
        raise ValueError("Pigeon name must be 30 characters or fewer")
    if not stripped.isprintable():
        raise ValueError("Pigeon name must contain only printable characters")
    return stripped
