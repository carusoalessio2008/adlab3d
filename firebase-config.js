<script type="module">
  // Import the functions you need from the SDKs you need
  import { initializeApp } from "https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js";
  import { getAnalytics } from "https://www.gstatic.com/firebasejs/13.4.0/firebase-analytics.js";
  // TODO: Add SDKs for Firebase products that you want to use
  // https://firebase.google.com/docs/web/setup#available-libraries

  // Your web app's Firebase configuration
  // For Firebase JS SDK v7.20.0 and later, measurementId is optional
  const firebaseConfig = {
    apiKey: "AIzaSyChgeOMoXXElgWT-vNkQt_ahxSGSbtHLr8",
    authDomain: "adlab3d-cloud.firebaseapp.com",
    projectId: "adlab3d-cloud",
    storageBucket: "adlab3d-cloud.firebasestorage.app",
    messagingSenderId: "313970364035",
    appId: "1:313970364035:web:f2b85dcc580380b02ad5b6",
    measurementId: "G-TM798LD9B7"
  };

  // Initialize Firebase
  const app = initializeApp(firebaseConfig);
  const analytics = getAnalytics(app);
</script>
