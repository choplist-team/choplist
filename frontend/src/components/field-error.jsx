export function FieldError({ id, message }) {
  if (!message) return null;

  return (
    <p id={id} className="text-sm text-destructive">
      {message}
    </p>
  );
}
