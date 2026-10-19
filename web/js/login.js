/* 登录页：邮箱密码登录、首次登录设置新密码；企业 SSO 暂未开放 */

import { $, toast } from './util.js';
import { config } from './config.js';
import { login, completeNewPassword, hasPendingChallenge } from './auth.js';
import { art, THUMBS } from './art.js';

function showError(which, msg, focusSel) {
  const el = $(`#${which}-error`);
  el.textContent = msg;
  el.hidden = !msg;
  if (focusSel) $(focusSel)?.focus();
}

function setBusy(sel, on, text) {
  const b = $(sel);
  b.disabled = on;
  b.classList.toggle('is-busy', on);
  b.textContent = text;
}

function showStep(step) {
  $('#login-form').hidden = step !== 'login';
  $('#newpw-form').hidden = step !== 'newpw';
  showError('login', '');
  showError('newpw', '');
  (step === 'login' ? $('#login-email') : $('#newpw-1')).focus();
}

/** 登录成功：回到登录前想去的页面 */
function done() {
  $('#login-pw').value = '';
  $('#newpw-1').value = '';
  $('#newpw-2').value = '';
  const next = sessionStorage.getItem('slate-next');
  sessionStorage.removeItem('slate-next');
  location.hash = next && !next.startsWith('#login') ? next.slice(1) : 'compose';
}

async function onLogin(e) {
  e.preventDefault();
  const email = $('#login-email').value.trim();
  const pw = $('#login-pw').value;
  if (!email) return showError('login', '请填写工作邮箱', '#login-email');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showError('login', '邮箱格式不对，检查一下', '#login-email');
  if (!pw) return showError('login', '请填写密码', '#login-pw');
  showError('login', '');
  setBusy('#login-submit', true, '登录中…');
  try {
    const r = await login(email, pw);
    if (r.challenge === 'NEW_PASSWORD_REQUIRED') {
      $('#login-pw').value = '';
      showStep('newpw');
      return;
    }
    done();
  } catch (err) {
    showError('login', err.message);
  } finally {
    setBusy('#login-submit', false, '登录');
  }
}

async function onNewPassword(e) {
  e.preventDefault();
  const a = $('#newpw-1').value;
  const b = $('#newpw-2').value;
  if (a.length < 8) return showError('newpw', '新密码至少需要 8 位', '#newpw-1');
  if (a !== b) return showError('newpw', '两次输入的密码不一样', '#newpw-2');
  showError('newpw', '');
  setBusy('#newpw-submit', true, '正在设置…');
  try {
    await completeNewPassword(a);
    toast('新密码已设置，以后用新密码登录');
    showStep('login');
    done();
  } catch (err) {
    showError('newpw', err.message);
  } finally {
    setBusy('#newpw-submit', false, '设置并登录');
  }
}

export function enter() {
  if (sessionStorage.getItem('slate-expired')) {  // 登录过期后整页重载回到这里（api.js 的 expireSession）
    sessionStorage.removeItem('slate-expired');
    toast('登录已过期，请重新登录', 'error');
  }
  if (!hasPendingChallenge()) showStep('login');
}

export function init() {
  $('#login-reel').innerHTML = [['editorial', '编辑图解'], ['swiss', '瑞士网格'], ['arena', '霓虹擂台']]
    .map(([id, name]) => `<li>${art(THUMBS[id], '')}<span>${name}</span></li>`).join('');
  $('#mock-hint').hidden = !config().mock;

  $('#login-form').addEventListener('submit', onLogin);
  $('#newpw-form').addEventListener('submit', onNewPassword);
  $('#sso-btn').addEventListener('click', () => toast('企业账号单点登录即将支持，请先用邮箱和密码登录'));
  $('#forgot-link').addEventListener('click', e => { e.preventDefault(); toast('忘记密码请联系管理员重置'); });
  $('#trial-link').addEventListener('click', e => { e.preventDefault(); toast('Slate 目前只对受邀用户开放，请联系管理员开通账号'); });
  $('#newpw-back').addEventListener('click', e => { e.preventDefault(); showStep('login'); });
}
