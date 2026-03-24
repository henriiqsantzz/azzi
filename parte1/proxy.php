<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');

function onlyDigits(string $value): string {
  return preg_replace('/\\D+/', '', $value) ?? '';
}

function isValidCpf(string $cpf): bool {
  $cpf = onlyDigits($cpf);
  if (strlen($cpf) !== 11) return false;
  if (preg_match('/^(\\d)\\1{10}$/', $cpf)) return false;

  $sum = 0;
  for ($i = 0, $weight = 10; $i < 9; $i++, $weight--) {
    $sum += ((int)$cpf[$i]) * $weight;
  }
  $remainder = ($sum * 10) % 11;
  if ($remainder === 10) $remainder = 0;
  if ($remainder !== (int)$cpf[9]) return false;

  $sum = 0;
  for ($i = 0, $weight = 11; $i < 10; $i++, $weight--) {
    $sum += ((int)$cpf[$i]) * $weight;
  }
  $remainder = ($sum * 10) % 11;
  if ($remainder === 10) $remainder = 0;
  if ($remainder !== (int)$cpf[10]) return false;

  return true;
}

$cpf = isset($_GET['cpf']) ? (string)$_GET['cpf'] : '';
$cpf = onlyDigits($cpf);

if ($cpf === '') {
  http_response_code(400);
  echo json_encode(['ok' => false, 'error' => 'CPF ausente'], JSON_UNESCAPED_UNICODE);
  exit;
}

if (!isValidCpf($cpf)) {
  http_response_code(422);
  echo json_encode(['ok' => false, 'error' => 'CPF inválido'], JSON_UNESCAPED_UNICODE);
  exit;
}

echo json_encode(['ok' => true, 'cpf' => $cpf], JSON_UNESCAPED_UNICODE);

