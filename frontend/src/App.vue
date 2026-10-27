<script setup>
import { onMounted } from 'vue'
import { session, restoreSession, logout } from './auth.js'
import AuthPage from './components/AuthPage.vue'
import Dashboard from './components/Dashboard.vue'
onMounted(restoreSession)
</script>

<template>
  <main v-if="session.checking || session.ending" aria-busy="true">
    <p class="loading-message" role="status">{{ session.ending ? '正在退出并清理页面…' : '正在恢复登录状态…' }}</p>
  </main>
  <Dashboard v-else-if="session.user" :key="session.version" :user="session.user" />
  <AuthPage v-else :key="session.version" />
  <div v-if="!session.user && session.error" class="auth-recovery">
    <p class="error" role="alert">{{ session.error }}</p>
    <button class="secondary" @click="restoreSession">重新检查连接</button>
    <button class="secondary" @click="logout">重试退出</button>
  </div>
</template>
