import Header from './components/Header';
import Hero from './components/Hero';
import Beneficios from './components/Beneficios';
import Calculadora from './components/Calculadora';
import Comparativo from './components/Comparativo';
import Planos from './components/Planos';
import Funcionalidades from './components/Funcionalidades';
import Contato from './components/Contato';
import Faq from './components/Faq';
import CtaFinal from './components/CtaFinal';
import Rodape from './components/Rodape';
import WhatsAppFlutuante from './components/WhatsAppFlutuante';

export default function App() {
  return (
    <>
      <Header />
      <main>
        <Hero />
        <Beneficios />
        <Funcionalidades />
        <Calculadora />
        <Comparativo />
        <Planos />
        <Contato />
        <Faq />
        <CtaFinal />
      </main>
      <Rodape />
      <WhatsAppFlutuante />
    </>
  );
}
